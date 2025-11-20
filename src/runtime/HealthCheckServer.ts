import http from 'http'
import type { AgentConfig } from '../config'
import { logger } from '../utils/logger'

/**
 * HTTP health check server for monitoring agent status
 */
export class HealthCheckServer {
  private config: AgentConfig
  private server: http.Server | null = null
  private getHealthStatus: (() => any) | null = null

  constructor(config: AgentConfig) {
    this.config = config
  }

  /**
   * Start the health check server
   */
  async start(getHealthStatus: () => any): Promise<void> {
    this.getHealthStatus = getHealthStatus

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res)
      })

      this.server.on('error', (error) => {
        logger.error('Health check server error', { error })
        reject(error)
      })

      this.server.listen(this.config.healthCheckPort, () => {
        logger.info('Health check server started', {
          port: this.config.healthCheckPort,
        })
        resolve()
      })
    })
  }

  /**
   * Stop the health check server
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return
    }

    return new Promise((resolve) => {
      this.server!.close(() => {
        logger.info('Health check server stopped')
        resolve()
      })
    })
  }

  /**
   * Handle HTTP requests
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '/'

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    // Handle OPTIONS for CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Only allow GET requests
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }

    // Route handling
    if (url === '/health') {
      this.handleHealthCheck(res)
    } else if (url === '/') {
      this.handleRoot(res)
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  }

  /**
   * Handle /health endpoint
   */
  private handleHealthCheck(res: http.ServerResponse): void {
    try {
      const status = this.getHealthStatus ? this.getHealthStatus() : { status: 'unknown' }

      const statusCode = status.status === 'healthy' ? 200 : 503

      res.writeHead(statusCode, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(status, null, 2))
    } catch (error: any) {
      logger.error('Health check failed', { error: error.message })

      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'error',
        error: error.message,
      }))
    }
  }

  /**
   * Handle / (root) endpoint
   */
  private handleRoot(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      name: 'adno-agent',
      version: process.env.npm_package_version || '1.0.0',
      endpoints: {
        health: '/health',
      },
    }))
  }
}