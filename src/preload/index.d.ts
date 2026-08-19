import type { BugretteApi } from '@shared/types'

declare global {
  interface Window {
    api: BugretteApi
  }
}

export {}
