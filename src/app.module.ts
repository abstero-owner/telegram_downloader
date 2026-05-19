import { Module } from "@nestjs/common";
import { AppController, AppControllerV1 } from "./app.controller";
import { AppService } from "./app.service";
import { ConfigModule } from "@nestjs/config";

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
		}),
	],
	controllers: [AppController, AppControllerV1],
	providers: [AppService],
})
export class AppModule {}
