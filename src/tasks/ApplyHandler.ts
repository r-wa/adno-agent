import type { TaskHandler, TaskContext } from '../runtime/TaskExecutor'
import type { AgentTask } from '../api/BackendApiClient'
import { logger } from '../utils/logger'
import { createAuthenticatedClient } from '../utils/authenticated-http'

interface Vote {
  id: string
  candidate_id: string
  resolution: 'YES' | 'NO'
  reviewer_id: string
  created_at: string
}

/**
 * Handler for consensus evaluation tasks
 * Calculates voting consensus and sends results to backend
 */
export class ConsensusEvaluationHandler implements TaskHandler {
  async execute(task: AgentTask, context: TaskContext): Promise<Record<string, any>> {
    logger.info('Starting consensus evaluation', { taskId: task.id })

    const candidateId = task.payload.candidate_id
    if (!candidateId) {
      throw new Error('candidate_id is required in payload')
    }

    try {
      // 1. Fetch candidate and votes from backend
      const [candidate, votes] = await Promise.all([
        this.fetchCandidate(context, candidateId),
        this.fetchVotes(context, candidateId),
      ])

      logger.info('Fetched candidate and votes', {
        candidateId,
        voteCount: votes.length,
      })

      // 2. Calculate consensus
      const yesVotes = votes.filter(v => v.resolution === 'YES')
      const noVotes = votes.filter(v => v.resolution === 'NO')

      // Consensus threshold (configurable, default 3)
      const approvalThreshold = 3
      const consensusReached = yesVotes.length >= approvalThreshold

      logger.info('Calculated consensus', {
        candidateId,
        yesVotes: yesVotes.length,
        noVotes: noVotes.length,
        consensusReached,
      })

      // 3. Send result to backend for persistence
      await this.submitConsensusResult(context, {
        candidateId,
        consensusReached,
        approvalCount: yesVotes.length,
        yesVoters: yesVotes.map(v => v.reviewer_id),
        noVoters: noVotes.map(v => v.reviewer_id),
      })

      logger.info('Consensus evaluation completed')

      return {
        candidate_id: candidateId,
        consensus_reached: consensusReached,
        approval_count: yesVotes.length,
        success: true,
      }
    } catch (error: any) {
      logger.error('Consensus evaluation failed', { error: error.message })
      throw error
    }
  }

  /**
   * Fetch candidate from backend
   */
  private async fetchCandidate(context: TaskContext, candidateId: string): Promise<any> {
    const client = createAuthenticatedClient(context)
    return await client.get(`/api/agent/candidates/${candidateId}`)
  }

  /**
   * Fetch votes for a candidate from backend
   */
  private async fetchVotes(context: TaskContext, candidateId: string): Promise<Vote[]> {
    const client = createAuthenticatedClient(context)
    const data = await client.get<{ votes: Vote[] }>(`/api/agent/candidates/${candidateId}/votes`)
    return data.votes || []
  }

  /**
   * Submit consensus result to backend
   */
  private async submitConsensusResult(
    context: TaskContext,
    result: {
      candidateId: string
      consensusReached: boolean
      approvalCount: number
      yesVoters: string[]
      noVoters: string[]
    }
  ): Promise<void> {
    const client = createAuthenticatedClient(context)
    await client.post(
      `/api/agent/consensus/result`,
      {
        candidate_id: result.candidateId,
        consensus_reached: result.consensusReached,
        approval_count: result.approvalCount,
        yes_voters: result.yesVoters,
        no_voters: result.noVoters,
      }
    )
  }
}