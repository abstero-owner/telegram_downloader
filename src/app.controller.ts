import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { AppService } from "./app.service";
import { BadRequestError } from "telegram/errors";

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

	@Get("v2/channels")
	async getChannelsV2() {
		const channels = await this.appService.getChannelsV2();

		return {
			channels,
		};
	}
}

@Controller("v1")
export class AppControllerV1 {
	constructor(private readonly appService: AppService) {}

	@Get("channels")
	async getChannels(@Query("id") channelId: string) {
		const channels = [];

		return channels;
	}

	@Get("messages")
	async getMessages(@Query("channel") channel: string) {
		if (!channel) {
			throw new BadRequestException("Channel query parameter is required");
		}

		const messages = await this.appService.getMessagesV2({
			channel,
		});

		return {
			messages,
		};
	}
}
