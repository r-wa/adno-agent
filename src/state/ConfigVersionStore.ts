/**
 * Interface for storing and retrieving configuration version
 * Separates config version tracking from HTTP client concerns
 */
export interface ConfigVersionStore {
  getVersion(): string | null
  setVersion(version: string): void
}

/**
 * In-memory implementation of config version store
 * Stores version in memory for the lifetime of the agent process
 */
export class InMemoryConfigVersionStore implements ConfigVersionStore {
  private version: string | null = null

  getVersion(): string | null {
    return this.version
  }

  setVersion(version: string): void {
    this.version = version
  }
}
