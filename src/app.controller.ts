import { Controller, Get, Query } from "@nestjs/common";
import { AppService } from "./app.service";


@Controller()
export class AppController {
	constructor(private readonly appService: AppService) {}

	@Get("health")
	getHealth() {
		return {
			status: "ok",
		};
	}
	@Get("channels")
	async getChannels() {
		const channels = await this.appService.getChannels();

		return {
			channels,
		};
	}

	@Get("messages")
	async getMessages(@Query("channelId") channelId: string) {
		const messages = await this.appService.getMessages(channelId);

		return {
			messages,
		};
	}
}
