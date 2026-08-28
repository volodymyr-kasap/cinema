import { Injectable } from '@nestjs/common';

import { parseEnv, type AppConfig } from './env';

@Injectable()
export class ConfigService {
  readonly config: AppConfig = parseEnv(process.env);
}
