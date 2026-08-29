import { createLogger } from '../../config/logger';
import type { ILogger } from '../../config/types';

export abstract class BaseService {
  protected readonly logger: ILogger;

  constructor(context: string) {
    this.logger = createLogger(context);
  }
}
