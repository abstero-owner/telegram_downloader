import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
	BadRequestException,
	Injectable,
	InternalServerErrorException,
	NotFoundException,
	type OnModuleInit,
} from "@nestjs/common";
import * as dayjs from "dayjs";
import { type Api, TelegramClient } from "telegram";
import type { Entity } from "telegram/define";
import { StringSession } from "telegram/sessions";

type NormalizedPost = {
	id: number;
	isAlbum: boolean;
	messages: Api.Message[]; // всегда массив: для одиночного — один элемент
	date: number;
	views: number | undefined;
	forwards: number | undefined;
};

function sleep(delay: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, delay);
	});
}

const s3 = new S3Client({
	region: "us-east-1",
	endpoint: process.env.S3_HOST as string,
	forcePathStyle: true,
	credentials: {
		accessKeyId: process.env.S3_LOGIN as string,
		secretAccessKey: process.env.S3_PASSWORD as string,
	},
});

const S3_BUCKET = process.env.S3_BUCKET_NAME as string; // имя твоего бакета

const session = new StringSession(process.env.TELEGRAM_SESSION_STRING);
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH as string;

@Injectable()
export class AppService implements OnModuleInit {
	private client: TelegramClient = new TelegramClient(session, apiId, apiHash, {
		connectionRetries: 5,
	});

	async onModuleInit() {
		// @ts-expect-error session string is already present
		await this.client.start();
	}

	async getChannels() {
		try {
			const dialogs = await this.client.getDialogs();

			const channels = dialogs.reduce(
				(acc, dialog) => {
					if (dialog.entity && dialog.entity.className === "Channel") {
						acc.push({
							id: dialog.entity.id.toJSNumber(),
							title: dialog.entity.title,
							username: dialog.entity.username || null,
						});
					}
					return acc;
				},
				[] as { id: number; title: string; username: string | null }[],
			);

			return channels;
		} catch (error) {
			throw new InternalServerErrorException(error.message);
		}
	}

	async getMessages(
		channelID: string,
		options: Partial<{ limit: number }> = {},
	) {
		const { limit = 10 } = options;

		if (!channelID) {
			throw new BadRequestException("channelId query parameter is required");
		}

		try {
			const dialogs = await this.client.getDialogs();

			const targetChannel = dialogs.find(
				(d) =>
					d.entity &&
					d.entity.className === "Channel" &&
					(d.entity.id.toString() === channelID ||
						d.entity.username?.toString() === channelID),
			);

			if (!targetChannel) {
				throw new NotFoundException(
					"Channel you are looking for was not found",
				);
			}

			const entity = targetChannel.entity as Entity;

			const rawMessages = await this.client.getMessages(entity, { limit });

			const groups = new Map<string, NormalizedPost>();
			const ordered: NormalizedPost[] = [];

			for (const message of rawMessages) {
				if (message.groupedId) {
					const gid = String(message.groupedId);
					let post = groups.get(gid);
					if (!post) {
						post = {
							id: message.id,
							isAlbum: true,
							messages: [],
							date: message.date,
							views: message.views,
							forwards: message.forwards,
						};
						groups.set(gid, post);
						ordered.push(post);
					}
					post.messages.push(message);
				} else {
					ordered.push({
						id: message.id,
						isAlbum: false,
						messages: [message],
						date: message.date,
						views: message.views,
						forwards: message.forwards,
					});
				}
			}

			const messages = await Promise.all(
				ordered.map(async (post) => {
					let text = "";
					const mediaFiles: string[] = [];

					for (const mm of post.messages) {
						if (mm.message) text += `${mm.message}\n`;

						const url = await this.uploadMediaToS3(mm);

						await sleep(1000);

						if (url) mediaFiles.push(url);
					}

					return {
						id: post.id,
						isAlbum: post.isAlbum,
						text: text.trim(),
						date: dayjs(post.date * 1000).toISOString(),
						views: post.views,
						forwards: post.forwards,
						mediaFiles,
					};
				}),
			);

			return messages;
		} catch (error) {
			throw new InternalServerErrorException(error.message);
		}
	}

	private async uploadMediaToS3(message: any): Promise<string | null> {
		if (!message?.media || message.webPreview) return null;

		try {
			const buffer = (await this.client.downloadMedia(
				message.media,
				{},
			)) as Buffer;

			if (!buffer || buffer.length === 0) return null;

			const originalName =
				message.media.document?.attributes?.find((a: any) => a.fileName)
					?.fileName ||
				(message.media.className === "MessageMediaPhoto"
					? `photo_${message.id}.jpg`
					: `media_${message.id}`);

			// уникальный ключ, чтобы файлы из разных каналов/сообщений не перетирали друг друга
			const key = `${message.id}_${Date.now()}_${originalName}`;

			await s3.send(
				new PutObjectCommand({
					Bucket: S3_BUCKET,
					Key: key,
					Body: buffer,
					ContentType: this.guessContentType(originalName, message),
				}),
			);

			return `${S3_BUCKET}/${key}`;
		} catch (e: any) {
			console.error(`Ошибка загрузки медиа в S3: ${e.message}`);
			return null;
		}
	}

	private guessContentType(fileName: string, message: any): string {
		if (message?.media?.className === "MessageMediaPhoto") {
			return "image/jpeg";
		}
		const ext = fileName.split(".").pop()?.toLowerCase();

		const map: Record<string, string> = {
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			png: "image/png",
			gif: "image/gif",
			webp: "image/webp",
			mp4: "video/mp4",
			mov: "video/quicktime",
			webm: "video/webm",
			mp3: "audio/mpeg",
			ogg: "audio/ogg",
			pdf: "application/pdf",
		};

		return (ext && map[ext]) || "application/octet-stream";
	}
}
