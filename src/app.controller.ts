import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { AppService } from "./app.service";
import {
	DispatchModerationBodyDto,
	DownloadMediaParamsDto,
	GetMessagesParamsDto,
	GetMessagesQueryDto,
} from "./dtos";

@Controller()
export class AppController {
	constructor(private readonly appService: AppService) {}

	@Get("health")
	getHealth() {
		return {
			status: "ok",
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

	@Get("channels/:channelId/messages")
	async getMessages(
		@Param() params: GetMessagesParamsDto,
		@Query() query: GetMessagesQueryDto,
	) {
		return this.appService.getMessagesV2({
			channel: params.channelId,
			minId: query.min_id,
		});
	}

	@Get("channels/:channelId/messages/:messageId/media")
	async downloadMessageMedia(@Param() params: DownloadMediaParamsDto) {
		return this.appService.uploadMediaToTelegram({
			channel: params.channelId,
			messageId: params.messageId,
		});
	}

	@Post("moderation/message/dispatch")
	async dispatchToModeration(@Body() body: DispatchModerationBodyDto) {
		const data = await this.dispatchToModeration(body);

		return { data };
	}
}
