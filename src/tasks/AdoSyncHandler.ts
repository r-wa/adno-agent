import type { TaskHandler, TaskContext } from '../runtime/TaskExecutor'
import type { AgentTask } from '../api/BackendApiClient'
import { logger } from '../utils/logger'
import { http } from '../utils/fetch-helper'
import { createAuthenticatedClient } from '../utils/authenticated-http'

interface AdoWorkItem {
  id: number
  fields: {
    'System.Title'?: string  // Optional - not fetched for minimal sync
    'System.Description'?: string  // Optional - not fetched for minimal sync
    'Microsoft.VSTS.Common.AcceptanceCriteria'?: string  // Optional - not fetched for minimal sync
    'System.WorkItemType': string
    'System.State': string
    'System.AssignedTo'?: { displayName: string }
    'System.IterationPath'?: string
    'System.AreaPath'?: string
    'System.ChangedDate': string  // Required for tracking changes
    'System.CreatedDate': string  // Required for tracking creation
    'System.Tags'?: string
    [key: string]: any
  }
}

/**
 * Handler for Azure DevOps sync tasks
 * Fetches work items from ADO and sends them to backend for persistence
 */
export class AdoSyncHandler implements TaskHandler {
  async execute(task: AgentTask, context: TaskContext): Promise<Record<string, any>> {
    logger.info('Starting ADO sync', { taskId: task.id })

    const adoConfig = this.getAdoConfig(context)
    if (!adoConfig.organization || !adoConfig.project || !adoConfig.patToken) {
      throw new Error('ADO configuration is incomplete. Set ADO_ORGANIZATION, ADO_PROJECT, and ADO_PAT_TOKEN')
    }

    // Type assertion after validation
    const validatedConfig = adoConfig as {
      organization: string
      project: string
      patToken: string
    }

    try {
      // 1. Fetch work items from ADO
      const workItems = await this.fetchWorkItems(validatedConfig)
      logger.info(`Fetched ${workItems.length} work items from ADO`)

      // 2. Transform to candidate format
      const candidates = this.transformWorkItems(workItems)
      logger.info(`Transformed ${candidates.length} candidates`)

      // 3. Send to backend for persistence
      const result = await this.sendCandidatesToBackend(context, candidates, task.payload.sync_run_id)
      logger.info('ADO sync completed', result)

      return {
        fetched: workItems.length,
        imported: result.imported,
        updated: result.updated,
        skipped: result.skipped,
        success: true,
      }
    } catch (error: any) {
      logger.error('ADO sync failed', { error: error.message })
      throw error
    }
  }

  /**
   * Get ADO configuration from context
   * Prioritizes workspace config (from backend) over agent config (from .env)
   */
  private getAdoConfig(context: TaskContext) {
    // Prefer workspace config from backend (supports admin portal changes)
    if (context.workspaceConfig) {
      return {
        organization: context.workspaceConfig.ado_organization,
        project: context.workspaceConfig.ado_project,
        patToken: context.workspaceConfig.ado_pat_token,
      }
    }

    // Fallback to agent config from .env (for backward compatibility)
    return {
      organization: context.config.adoOrganization,
      project: context.config.adoProject,
      patToken: context.config.adoPatToken,
    }
  }

  /**
   * Fetch work items from Azure DevOps using WIQL
   */
  private async fetchWorkItems(config: {
    organization: string
    project: string
    patToken: string
  }): Promise<AdoWorkItem[]> {
    const baseUrl = `https://dev.azure.com/${config.organization}/${config.project}/_apis`

    // Create Basic auth header
    const authHeader = 'Basic ' + Buffer.from(`:${config.patToken}`).toString('base64')

    // Step 1: Execute WIQL query to get work item IDs
    // For incremental sync, could add: AND [System.ChangedDate] > @lastSyncDate
    const wiqlQuery = {
      query: `
        SELECT [System.Id], [System.ChangedDate]
        FROM WorkItems
        WHERE [System.WorkItemType] IN ('User Story', 'Task', 'Bug', 'Product Backlog Item')
          AND [System.State] NOT IN ('Done', 'Closed', 'Removed')
        ORDER BY [System.ChangedDate] DESC
      `,
    }

    const wiqlResponse = await http.post<any>(
      `${baseUrl}/wit/wiql?api-version=7.0`,
      wiqlQuery,
      {
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
      }
    )

    const workItemRefs = wiqlResponse.workItems || []
    if (workItemRefs.length === 0) {
      return []
    }

    // Step 2: Fetch work item details in batches (ADO API limit is 200)
    const ids = workItemRefs.map((ref: any) => ref.id)
    const batchSize = 200
    const allWorkItems: AdoWorkItem[] = []

    for (let i = 0; i < ids.length; i += batchSize) {
      const batchIds = ids.slice(i, i + batchSize)
      const idsParam = batchIds.join(',')

      // MINIMAL SYNC: Only fetch metadata fields, not content
      // Title, Description, AcceptanceCriteria will be fetched on-demand by web app
      const fieldsParam = [
        'System.Id',
        'System.WorkItemType',
        'System.State',
        'System.AssignedTo',
        'System.IterationPath',
        'System.AreaPath',
        'System.Tags',
        'System.ChangedDate',  // For tracking changes
        'System.CreatedDate',  // For tracking creation
      ].join(',')

      const detailsResponse = await http.get<{ value: AdoWorkItem[] }>(
        `${baseUrl}/wit/workitems?ids=${idsParam}&fields=${fieldsParam}&api-version=7.0`,
        {
          headers: {
            'Authorization': authHeader,
          },
        }
      )

      allWorkItems.push(...(detailsResponse.value || []))
    }

    return allWorkItems
  }

  /**
   * Transform ADO work items to candidate format (metadata only)
   * Content fields (title, description, acceptance_criteria) are NOT sent
   * They will be fetched on-demand by the web app
   */
  private transformWorkItems(workItems: AdoWorkItem[]): Array<{
    ado_work_item_id: string
    ado_changed_date: string
    ado_created_date: string
    context: Record<string, any>
  }> {
    return workItems.map(item => ({
      ado_work_item_id: item.id.toString(),
      ado_changed_date: item.fields['System.ChangedDate'],
      ado_created_date: item.fields['System.CreatedDate'],
      context: {
        workItemType: item.fields['System.WorkItemType'],
        state: item.fields['System.State'],
        assignedTo: item.fields['System.AssignedTo']?.displayName,
        iterationPath: item.fields['System.IterationPath'],
        areaPath: item.fields['System.AreaPath'],
        tags: item.fields['System.Tags'],
      },
    }))
  }

  /**
   * Strip HTML tags from ADO field values
   */
  private stripHtml(html: string): string {
    if (!html) return ''

    return html
      .replace(/<[^>]*>/g, '') // Remove HTML tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ') // Collapse whitespace
      .trim()
  }

  /**
   * Send candidates to backend for persistence
   */
  private async sendCandidatesToBackend(
    context: TaskContext,
    candidates: any[],
    syncRunId?: string
  ): Promise<{ imported: number; updated: number; skipped: number }> {
    const client = createAuthenticatedClient(context)
    const response = await client.post<{ imported: number; updated: number; skipped: number }>(
      `/api/agent/candidates/upsert`,
      {
        candidates,
        sync_run_id: syncRunId,
      }
    )

    return response
  }
}