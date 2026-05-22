// app/dto/messages.dto.ts
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const GetMessagesParamsSchema = z.object({
	channelId: z.string().min(1, "channelId is required"),
});

export class GetMessagesParamsDto extends createZodDto(
	GetMessagesParamsSchema,
) {}

export const GetMessagesQuerySchema = z.object({
	min_id: z.coerce.number().int().nonnegative().optional(),
});

export class GetMessagesQueryDto extends createZodDto(GetMessagesQuerySchema) {}

export const DownloadMediaParamsSchema = z.object({
	channelId: z.string().min(1, "channelId is required"),
	messageId: z.coerce
		.number()
		.int()
		.positive("messageId must be a positive integer"),
});

export class DownloadMediaParamsDto extends createZodDto(
	DownloadMediaParamsSchema,
) {}

export const DispatchModerationBodySchema = z.object({
	chat_id: z.number().int().positive(),
	text: z.string().trim().min(4),
	tg_message_ids: z.array(z.number().int().positive()),
});

export class DispatchModerationBodyDto extends createZodDto(
	DispatchModerationBodySchema,
) {}
