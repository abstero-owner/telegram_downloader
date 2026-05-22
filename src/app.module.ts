import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_PIPE } from "@nestjs/core";
import { ZodValidationPipe } from "nestjs-zod";
import { AppController, AppControllerV1 } from "./app.controller";
import { AppService } from "./app.service";
import { TelegramService } from "./telegram.service";

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
		}),
	],
	controllers: [AppController, AppControllerV1],
	providers: [
		AppService,
		{ provide: APP_PIPE, useClass: ZodValidationPipe },
		TelegramService,
	],
})
export class AppModule {}
