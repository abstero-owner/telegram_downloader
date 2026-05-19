import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
	BadRequestException,
	Injectable,
	InternalServerErrorException,
	NotFoundException,
	type OnModuleInit,
} from "@nestjs/common";
import * as dayjs from "dayjs";
import { Api, TelegramClient } from "telegram";
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

type GroupedMessage = {
	id: number;
	text: string;
	media: unknown[];
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

	async getChannelsV2() {
		const result = await this.client.invoke(
			new Api.channels.GetChannels({
				id: ["ru2ch"],
			}),
		);

		return result;
	}

	async getMessagesV2(options: { channel: string; messageIds?: number[] }) {
		const { channel, messageIds } = options;

		const LIMIT = 10;

		const tgMessages = await this.client.getMessages(channel, {
			limit: LIMIT,
			ids: messageIds,
		});

		// getMessages возвращает сообщения от новых к старым:
		// индекс 0 — самое новое, последний индекс — самое старое.
		const newest = tgMessages[0];
		const oldest = tgMessages[tgMessages.length - 1];

		// Собираем все сырые сообщения, начиная с основной выборки.
		const rawMessages = [...tgMessages];

		// --- Дочитываем нижнюю границу (старые сообщения) ---
		// Если самое старое сообщение в выборке принадлежит альбому,
		// часть этого альбома могла остаться за пределами пагинации (старее).
		if (oldest?.groupedId) {
			const targetGroupedId = oldest.groupedId;
			let offsetId = oldest.id;
			let keepFetching = true;

			while (keepFetching) {
				const extra = await this.client.getMessages(channel, {
					limit: 20,
					offsetId, // получаем сообщения СТАРЕЕ этого id
				});

				if (extra.length === 0) break;

				keepFetching = false;

				for (const m of extra) {
					if (m.groupedId && m.groupedId.equals(targetGroupedId)) {
						rawMessages.push(m);
						offsetId = m.id;
						// Продолжаем — вдруг альбом ещё длиннее, чем один батч.
						keepFetching = true;
					} else {
						// Дошли до сообщения из другой группы — альбом закончился.
						keepFetching = false;
						break;
					}
				}
			}
		}

		// --- Дочитываем верхнюю границу (новые сообщения) ---
		// Если самое новое сообщение принадлежит альбому, часть альбома
		// могла быть опубликована позже и не попасть в выборку.
		if (newest?.groupedId) {
			const targetGroupedId = newest.groupedId;
			let minId = newest.id;
			let keepFetching = true;

			while (keepFetching) {
				const extra = await this.client.getMessages(channel, {
					limit: 20,
					minId, // получаем сообщения НОВЕЕ этого id
				});

				if (extra.length === 0) break;

				keepFetching = false;

				// extra тоже идёт от новых к старым; нас интересуют только
				// сообщения того же альбома.
				for (const m of [...extra].reverse()) {
					if (m.groupedId && m.groupedId.equals(targetGroupedId)) {
						rawMessages.push(m);
						minId = Math.max(minId, m.id);
						keepFetching = true;
					}
				}
			}
		}

		// --- Нормализация ---
		const ungroupedMessages = rawMessages.map((rawMessage) => {
			const text = rawMessage.text;
			const id = rawMessage.id;
			const groupedId = rawMessage.groupedId
				? rawMessage.groupedId.toJSNumber()
				: null;

			return {
				text,
				id,
				groupedId,
				media: rawMessage.media,
			};
		});

		// Убираем возможные дубликаты (дочитанные сообщения могли пересечься
		// с основной выборкой) и сортируем от старых к новым для стабильного
		// порядка репоста.
		const seenIds = new Set<number>();
		const dedupedMessages = ungroupedMessages
			.filter((m) => {
				if (seenIds.has(m.id)) return false;
				seenIds.add(m.id);
				return true;
			})
			.sort((a, b) => a.id - b.id);

		// --- Группировка ---
		const groupedMessagesMap = new Map<number, GroupedMessage>();
		const result: GroupedMessage[] = [];

		for (const msg of dedupedMessages) {
			if (msg.groupedId !== null) {
				const existing = groupedMessagesMap.get(msg.groupedId);

				if (existing) {
					// Группа уже есть — добавляем media и подхватываем text, если его ещё нет
					if (msg.media != null) {
						existing.media.push(msg.media);
					}
					if (!existing.text && msg.text) {
						existing.text = msg.text;
					}
				} else {
					// Первый элемент группы
					const grouped: GroupedMessage = {
						id: msg.id,
						text: msg.text,
						media: msg.media != null ? [msg.media] : [],
					};
					groupedMessagesMap.set(msg.groupedId, grouped);
					result.push(grouped);
				}
			} else {
				result.push({
					id: msg.id,
					text: msg.text,
					media: msg.media != null ? [msg.media] : [],
				});
			}
		}

		return result;
	}

	async getMessageV2(options: { channel: string; messageId: number }) {}

	//================================================================================================================
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
