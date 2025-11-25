#!/usr/bin/env node

process.removeAllListeners('warning')

import dotenv from 'dotenv'
// Load .env file with override: true to prioritize .env values over system env vars
dotenv.config({ override: true })

import { AgentRuntime } from './runtime/AgentRuntime'
import { loadConfig, validateConfig } from './config'
import { logger, flushLogs } from './utils/logger'

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
      flushLogs()
      await new Promise(resolve => setTimeout(resolve, 500))
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
    logger.error('Fix the configuration and restart the service')

    // Flush logs before exiting to ensure error messages are captured
    flushLogs()

    // Brief delay to allow NSSM to capture output buffers
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Exit with error code so NSSM can detect failure and restart
    process.exit(1)
  }
}

// Run main function
main().catch((error) => {
  logger.error('Unhandled error in main', { error })
  flushLogs()
  setTimeout(() => process.exit(1), 500)
})