import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configFromEnv } from './config.js';

const config = configFromEnv();
const app = await NestFactory.create(AppModule.forRoot(config));
app.enableShutdownHooks();
await app.listen(config.httpPort, config.host);

const logger = new Logger('RelayoSim');
logger.log(`HTTP API on ${await app.getUrl()}`);
logger.log(`Storage: ${config.databaseUrl ? 'PostgreSQL' : 'memory'} · Queues: ${config.redisUrl ? 'BullMQ' : 'in-process'} · time scale ${config.timeScale}`);
if (!config.adminToken) logger.warn('ADMIN_TOKEN is not set: projects cannot be created over the API');
