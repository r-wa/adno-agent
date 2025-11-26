/**
 * Version Checker - Monitors for agent updates and logs recommendations
 */

import type { AgentConfig } from '../config'
import { logger } from '../utils/logger'

export interface VersionInfo {
  recommended_version: string
  download_url: string
  checksum_sha256: string
  release_notes: string | null
  is_required: boolean
  should_update: boolean
}

export class VersionChecker {
  private config: AgentConfig
  private currentVersion: string
  private lastCheckVersion: string | null = null

  constructor(config: AgentConfig) {
    this.config = config
    this.currentVersion = process.env.npm_package_version || '1.0.0'
  }

  /**
   * Check version info from config response and log if update is available
   */
  checkVersion(versionInfo: VersionInfo | null | undefined): void {
    if (!versionInfo) {
      logger.debug('[VersionChecker] No version info in config response')
      return
    }

    const { recommended_version, should_update, is_required, download_url, release_notes } =
      versionInfo

    // Don't log repeatedly for the same version
    if (this.lastCheckVersion === recommended_version) {
      return
    }

    this.lastCheckVersion = recommended_version

    // Compare versions
    if (this.isNewerVersion(recommended_version, this.currentVersion)) {
      if (is_required) {
        logger.warn(`REQUIRED UPDATE AVAILABLE: v${recommended_version}`, {
          current: this.currentVersion,
          recommended: recommended_version,
          download_url,
          release_notes: release_notes || 'No release notes',
        })
      } else if (should_update) {
        logger.info(`Update available: v${recommended_version}`, {
          current: this.currentVersion,
          recommended: recommended_version,
          download_url,
          release_notes: release_notes || 'No release notes',
        })
      } else {
        logger.debug(`Update exists but not in rollout cohort: v${recommended_version}`, {
          current: this.currentVersion,
          recommended: recommended_version,
        })
      }
    } else {
      logger.debug(`Agent is up to date: v${this.currentVersion}`)
    }
  }

  /**
   * Get current agent version
   */
  getCurrentVersion(): string {
    return this.currentVersion
  }

  /**
   * Simple semantic version comparison
   * Returns true if `candidate` is newer than `current`
   */
  private isNewerVersion(candidate: string, current: string): boolean {
    const candidateParts = candidate.split('.').map(Number)
    const currentParts = current.split('.').map(Number)

    for (let i = 0; i < Math.max(candidateParts.length, currentParts.length); i++) {
      const candidateNum = candidateParts[i] || 0
      const currentNum = currentParts[i] || 0

      if (candidateNum > currentNum) return true
      if (candidateNum < currentNum) return false
    }

    return false
  }
}
