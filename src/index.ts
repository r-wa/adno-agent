#!/usr/bin/env node

// Suppress experimental fetch warnings (Node 18 compatibility)
process.removeAllListeners('warning')

// IMPORTANT: Load environment variables BEFORE any other imports
// This ensures dotenv runs before logger and other modules try to read process.env
import dotenv from 'dotenv'
dotenv.config({ override: true })

import { AgentRuntime } from './runtime/AgentRuntime'
import { loadConfig, validateConfig } from './config'
import { logger } from './utils/logger'

/**
 * Main entry point for the adno agent
 */
async function main() {
  logger.info('Starting adno agent...')

  try {
    // Load configuration from environment
    const config = loadConfig()

    // Validate configuration
    const validation = validateConfig(config)
    if (!validation.valid) {
      logger.error('Configuration validation failed')
      validation.errors.forEach(error => logger.error(`  - ${error}`))
      process.exit(1)
    }

    logger.info('Configuration loaded and validated successfully', {
      apiUrl: config.apiUrl,
      pollIntervalMs: config.pollIntervalMs,
      maxConcurrentTasks: config.maxConcurrentTasks,
    })

    // Create and start the agent runtime
    const agent = new AgentRuntime(config)

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`)
      await agent.stop()
      process.exit(0)
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGUSR2', () => shutdown('SIGUSR2')) // Nodemon restart

    // Start the agent
    await agent.start()

    logger.info('Agent started successfully')
  } catch (error) {
    logger.error('Failed to start agent', { error })
    process.exit(1)
  }
}

// Run main function
main().catch((error) => {
  logger.error('Unhandled error in main', { error })
  process.exit(1)
})