import type { TaskHandler, TaskContext } from '../runtime/TaskExecutor'
import type { AgentTask } from '../api/BackendApiClient'
import { logger } from '../utils/logger'
import { http } from '../utils/fetch-helper'
import { createAuthenticatedClient } from '../utils/authenticated-http'

interface AdoWorkItem {
  id: number
  fields: {
    'System.WorkItemType': string
    'System.State': string
    'System.AssignedTo'?: { displayName: string }
    'System.IterationPath'?: string
    'System.AreaPath'?: string
    'System.ChangedDate': string
    'System.CreatedDate': string
    'System.Tags'?: string
    [key: string]: any
  }
}

// Default and maximum limits for items per sync
const DEFAULT_MAX_ITEMS = 500
const UPSERT_BATCH_SIZE = 200  // Send candidates in batches to avoid timeout

/**
 * Handler for FETCHER tasks - syncs work item metadata from Azure DevOps
 * Only fetches metadata (IDs, dates, context); content is fetched on-demand by the web app
 */
export class FetcherHandler implements TaskHandler {
  async execute(task: AgentTask, context: TaskContext): Promise<Record<string, any>> {
    // Get max_items from backend config, with fallback
    const maxItems = context.backendConfig?.workers?.fetcher?.max_items ?? DEFAULT_MAX_ITEMS
    logger.info('Starting ADO sync', { taskId: task.id, maxItems })

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
      // 1. Fetch work items from ADO (with limit)
      const workItems = await this.fetchWorkItems(validatedConfig, maxItems)
      logger.info(`Fetched ${workItems.length} work items from ADO (limit: ${maxItems})`)

      // 2. Transform to candidate format
      const candidates = this.transformWorkItems(workItems)
      logger.info(`Transformed ${candidates.length} candidates`)

      // 3. Send to backend for persistence (in batches to avoid timeout)
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
   * @param config ADO configuration
   * @param maxItems Maximum number of items to fetch (applied after WIQL query)
   */
  private async fetchWorkItems(config: {
    organization: string
    project: string
    patToken: string
  }, maxItems: number): Promise<AdoWorkItem[]> {
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

    // Apply max items limit (WIQL returns most recently changed first)
    const allIds = workItemRefs.map((ref: any) => ref.id)
    const limitedIds = allIds.slice(0, maxItems)

    if (allIds.length > maxItems) {
      logger.info(`Limiting sync from ${allIds.length} to ${maxItems} work items`)
    }

    // Step 2: Fetch work item details in batches (ADO API limit is 200)
    const batchSize = 200
    const allWorkItems: AdoWorkItem[] = []

    for (let i = 0; i < limitedIds.length; i += batchSize) {
      const batchIds = limitedIds.slice(i, i + batchSize)
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
   * Send candidates to backend for persistence
   * Sends in batches to avoid timeout on large payloads
   */
  private async sendCandidatesToBackend(
    context: TaskContext,
    candidates: any[],
    syncRunId?: string
  ): Promise<{ imported: number; updated: number; skipped: number }> {
    const client = createAuthenticatedClient(context)

    // Aggregate results across batches
    let totalImported = 0
    let totalUpdated = 0
    let totalSkipped = 0

    // Send in batches to avoid timeout
    for (let i = 0; i < candidates.length; i += UPSERT_BATCH_SIZE) {
      const batch = candidates.slice(i, i + UPSERT_BATCH_SIZE)
      const batchNumber = Math.floor(i / UPSERT_BATCH_SIZE) + 1
      const totalBatches = Math.ceil(candidates.length / UPSERT_BATCH_SIZE)

      logger.info(`Sending batch ${batchNumber}/${totalBatches} (${batch.length} candidates)`)

      const response = await client.post<{ imported: number; updated: number; skipped: number }>(
        `/api/agent/candidates/upsert`,
        {
          candidates: batch,
          sync_run_id: syncRunId,
        },
        {
          timeout: 120000,  // 2 minute timeout per batch (increased from default 30s)
        }
      )

      totalImported += response.imported
      totalUpdated += response.updated
      totalSkipped += response.skipped
    }

    return {
      imported: totalImported,
      updated: totalUpdated,
      skipped: totalSkipped,
    }
  }
}