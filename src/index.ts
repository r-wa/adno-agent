#!/usr/bin/env node

// IMPORTANT: Load environment variables BEFORE any other imports
// This ensures dotenv runs before logger and other modules try to read process.env
import dotenv from 'dotenv'
dotenv.config()

import { AgentRuntime } from './runtime/AgentRuntime'
import { loadConfig } from './config'
import { logger } from './utils/logger'

/**
 * Main entry point for the adno agent
 */
async function main() {
  logger.info('Starting adno agent...')

  try {
    // Load configuration from environment
    const config = loadConfig()

    // Validate required configuration
    if (!config.apiKey) {
      logger.error('ADNO_API_KEY is required')
      process.exit(1)
    }

    if (!config.apiUrl) {
      logger.error('ADNO_API_URL is required')
      process.exit(1)
    }

    logger.info('Configuration loaded successfully', {
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