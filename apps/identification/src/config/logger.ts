import { config } from './config';
import type { ILogger } from './types';

class Logger implements ILogger {
  private context: string;

  constructor(context: string = 'App') {
    this.context = context;
  }

  private formatMessage(level: string, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] [${this.context}] ${message}${dataStr}`;
  }

  debug(message: string, data?: unknown): void {
    if (config.getValue('logLevel') === 'debug') {
      console.log(this.formatMessage('debug', message, data));
    }
  }

  info(message: string, data?: unknown): void {
    if (['debug', 'info'].includes(config.getValue('logLevel'))) {
      console.log(this.formatMessage('info', message, data));
    }
  }

  warn(message: string, data?: unknown): void {
    if (['debug', 'info', 'warn'].includes(config.getValue('logLevel'))) {
      console.warn(this.formatMessage('warn', message, data));
    }
  }

  error(message: string, error?: unknown): void {
    const errorData = error instanceof Error ? error.message : String(error);
    console.error(this.formatMessage('error', message, errorData));
  }
}

export const createLogger = (context?: string): ILogger => new Logger(context);
export default Logger;
