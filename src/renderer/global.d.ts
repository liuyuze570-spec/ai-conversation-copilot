export {};
import type { CopilotApi } from '../main/preload';

declare global {
  interface Window {
    copilot: CopilotApi;
  }
}
