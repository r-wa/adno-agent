import type { TaskHandler, TaskContext } from '../runtime/TaskExecutor'
import type { AgentTask } from '../api/BackendApiClient'
import { logger } from '../utils/logger'
import { http } from '../utils/fetch-helper'
import { createAuthenticatedClient } from '../utils/authenticated-http'
import { createHash } from 'crypto'

interface Candidate {
  id: string
  title: string
  description: string
  acceptance_criteria: string
  field: 'TITLE' | 'DESCRIPTION' | 'ACCEPTANCE_CRITERIA'
}

interface ClarityReport {
  clarity_score: number
  issues: string[]
  suggested_improvements?: {
    title?: string
    description?: string
    acceptance_criteria?: string
  }
}

/**
 * Handler for SUGGESTION tasks - evaluates work item clarity using AI
 * Uses Azure OpenAI to evaluate clarity and generate improvement suggestions
 */
export class SuggestionHandler implements TaskHandler {
  async execute(task: AgentTask, context: TaskContext): Promise<Record<string, any>> {
    logger.info('Starting clarity suggestion', { taskId: task.id })

    const candidateId = task.payload.candidate_id
    if (!candidateId) {
      throw new Error('candidate_id is required in payload')
    }

    // Get Azure OpenAI configuration
    const openAiConfig = this.getOpenAiConfig(context)
    if (!openAiConfig.endpoint || !openAiConfig.apiKey) {
      throw new Error('Azure OpenAI configuration is incomplete. Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY')
    }

    // Type assertion after validation
    const validatedConfig = openAiConfig as {
      endpoint: string
      apiKey: string
      deployment: string
      apiVersion: string
    }

    try {
      // 1. Fetch candidate from backend
      const candidate = await this.fetchCandidate(context, candidateId)
      logger.info('Fetched candidate', { candidateId, title: candidate.title })

      // 2. Generate clarity evaluation using Azure OpenAI
      const report = await this.evaluateClarity(validatedConfig, candidate)
      logger.info('Generated clarity report', {
        candidateId,
        clarityScore: report.clarity_score,
        issuesCount: report.issues.length,
      })

      // 3. Calculate hash of candidate content for change detection
      const hash = this.hashCandidate(candidate)

      // 4. Send report to backend for persistence
      await this.submitClarityReport(context, candidateId, report, hash)
      logger.info('Clarity suggestion completed')

      return {
        candidate_id: candidateId,
        clarity_score: report.clarity_score,
        has_suggestions: !!report.suggested_improvements,
        success: true,
      }
    } catch (error: any) {
      logger.error('Clarity suggestion failed', { error: error.message })
      throw error
    }
  }

  /**
   * Get Azure OpenAI configuration
   * Prioritizes workspace config (from backend) over agent config (from .env)
   */
  private getOpenAiConfig(context: TaskContext) {
    // Prefer workspace config from backend (supports admin portal changes)
    if (context.workspaceConfig) {
      return {
        endpoint: context.workspaceConfig.azure_openai_endpoint,
        apiKey: context.workspaceConfig.azure_openai_api_key,
        deployment: context.workspaceConfig.azure_openai_deployment || 'gpt-4',
        apiVersion: context.workspaceConfig.azure_openai_api_version || '2024-02-15-preview',
      }
    }

    // Fallback to agent config from .env (for backward compatibility)
    return {
      endpoint: context.config.azureOpenAiEndpoint,
      apiKey: context.config.azureOpenAiApiKey,
      deployment: context.config.azureOpenAiDeployment || 'gpt-4',
      apiVersion: context.config.azureOpenAiApiVersion || '2024-02-15-preview',
    }
  }

  /**
   * Fetch candidate from backend
   */
  private async fetchCandidate(context: TaskContext, candidateId: string): Promise<Candidate> {
    const client = createAuthenticatedClient(context)
    return await client.get<Candidate>(`/api/agent/candidates/${candidateId}`)
  }

  /**
   * Evaluate clarity using Azure OpenAI
   */
  private async evaluateClarity(
    config: {
      endpoint: string
      apiKey: string
      deployment: string
      apiVersion: string
    },
    candidate: Candidate
  ): Promise<ClarityReport> {
    const prompt = this.buildClarityPrompt(candidate)

    const url = `${config.endpoint}/openai/deployments/${config.deployment}/chat/completions?api-version=${config.apiVersion}`

    const response = await http.post<any>(
      url,
      {
        messages: [
          {
            role: 'system',
            content: 'You are an expert at evaluating and improving work item clarity for software development teams.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          'api-key': config.apiKey,
          'Content-Type': 'application/json',
        },
      }
    )

    const content = response.choices[0].message.content
    const report = JSON.parse(content) as ClarityReport

    return report
  }

  /**
   * Build clarity evaluation prompt
   */
  private buildClarityPrompt(candidate: Candidate): string {
    return `
Evaluate the clarity of this work item and provide suggestions for improvement.

**Work Item:**
- Title: ${candidate.title}
- Description: ${candidate.description || '(empty)'}
- Acceptance Criteria: ${candidate.acceptance_criteria || '(empty)'}

**Instructions:**
1. Assign a clarity score from 0-10 (10 = perfectly clear)
2. List specific clarity issues (vague language, missing details, ambiguity)
3. If score < 7, provide suggested improvements

**Response format (JSON):**
{
  "clarity_score": <number 0-10>,
  "issues": ["issue 1", "issue 2", ...],
  "suggested_improvements": {
    "title": "<improved title if needed>",
    "description": "<improved description if needed>",
    "acceptance_criteria": "<improved acceptance criteria if needed>"
  }
}

**Evaluation criteria:**
- Is the title concise and descriptive?
- Does the description explain WHAT and WHY clearly?
- Are acceptance criteria specific, measurable, and testable?
- Is there any vague or ambiguous language?
- Are there any missing details needed for implementation?

Respond ONLY with valid JSON.
`
  }

  /**
   * Calculate hash of candidate content for change detection
   * Uses SHA-256 for reliable collision detection
   */
  private hashCandidate(candidate: Candidate): string {
    const content = `${candidate.title}|${candidate.description}|${candidate.acceptance_criteria}`
    return createHash('sha256').update(content).digest('hex')
  }

  /**
   * Submit clarity report to backend
   */
  private async submitClarityReport(
    context: TaskContext,
    candidateId: string,
    report: ClarityReport,
    hash: string
  ): Promise<void> {
    const client = createAuthenticatedClient(context)
    await client.post(
      `/api/agent/clarity/report`,
      {
        candidate_id: candidateId,
        report,
        hash,
        tokens_used: 0, // Would track actual token usage
      }
    )
  }
}