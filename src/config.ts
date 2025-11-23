import dotenv from 'dotenv'

// Load environment variables from .env file (override existing env vars)
dotenv.config({ override: true })

export interface AgentConfig {
  // API Configuration
  apiKey: string
  apiUrl: string

  // Agent Behavior
  pollIntervalMs: number
  heartbeatIntervalMs: number
  maxConcurrentTasks: number

  // Azure DevOps Configuration
  adoOrganization?: string
  adoProject?: string
  adoPatToken?: string

  // Azure OpenAI Configuration
  azureOpenAiEndpoint?: string
  azureOpenAiApiKey?: string
  azureOpenAiDeployment?: string
  azureOpenAiApiVersion?: string

  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  logFormat: 'json' | 'text'
}

/**
 * Load agent configuration from environment variables
 */
export function loadConfig(): AgentConfig {
  return {
    // Required
    apiKey: process.env.ADNO_API_KEY || '',
    apiUrl: process.env.ADNO_API_URL || 'https://app.adno.dev',

    // Agent settings (with defaults)
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '30000', 10),
    heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '60000', 10),
    maxConcurrentTasks: parseInt(process.env.MAX_CONCURRENT_TASKS || '3', 10),

    // Azure DevOps (optional - can be configured in backend)
    adoOrganization: process.env.ADO_ORGANIZATION,
    adoProject: process.env.ADO_PROJECT,
    adoPatToken: process.env.ADO_PAT_TOKEN,

    // Azure OpenAI (optional - can be configured in backend)
    azureOpenAiEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
    azureOpenAiApiKey: process.env.AZURE_OPENAI_API_KEY,
    azureOpenAiDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
    azureOpenAiApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview',

    // Logging
    logLevel: (process.env.LOG_LEVEL as any) || 'info',
    logFormat: (process.env.LOG_FORMAT as any) || 'json',
  }
}

/**
 * Validate agent configuration
 */
export function validateConfig(config: AgentConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!config.apiKey || !config.apiKey.startsWith('agnt_')) {
    errors.push('Invalid ADNO_API_KEY (must start with "agnt_")')
  }

  if (!config.apiUrl || !config.apiUrl.startsWith('http')) {
    errors.push('Invalid ADNO_API_URL (must be a valid URL)')
  }

  if (config.pollIntervalMs < 5000 || config.pollIntervalMs > 300000) {
    errors.push('POLL_INTERVAL_MS must be between 5000 and 300000')
  }

  if (config.heartbeatIntervalMs < 10000 || config.heartbeatIntervalMs > 600000) {
    errors.push('HEARTBEAT_INTERVAL_MS must be between 10000 and 600000')
  }

  if (config.maxConcurrentTasks < 1 || config.maxConcurrentTasks > 10) {
    errors.push('MAX_CONCURRENT_TASKS must be between 1 and 10')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}