import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

export interface ILogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, error?: unknown): void;
}

export interface IRequestHandler {
  handle(event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult>;
}

export interface IMiddleware {
  execute(event: APIGatewayProxyEvent, context: Context): Promise<boolean>;
}

export interface HandlerResponse {
  statusCode: number;
  body: unknown;
  headers?: Record<string, string>;
}
