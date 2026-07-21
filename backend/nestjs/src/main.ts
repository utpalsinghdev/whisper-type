import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import configuration from './config/configuration';

async function bootstrap() {
  const config = configuration();
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: config.corsOrigin,
    credentials: true,
  });

  app.use(cookieParser());
  app.use(json({ limit: '30mb' }));
  app.use(urlencoded({ extended: true, limit: '30mb' }));

  await app.listen(config.port, config.host);
  console.log(`WishperType backend listening on http://${config.host}:${config.port}`);
  console.log(`Health:      http://${config.host}:${config.port}/health`);
  console.log(`Dashboard:   http://${config.host}:${config.port}/dashboard`);
  console.log(`Transcribe:  POST /transcribe_pcm_chunk`);
}

bootstrap();
