import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
	BadRequestException,
	Injectable,
	NotFoundException,
	type OnModuleInit,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import * as dayjs from "dayjs";

type Post = {
	postId: number; // id первого сообщения в группе (или единственного)
	text: string; // caption/text поста
	mediaMessageIds: number[]; // все id сообщений с медиа (включая postId если у него есть media)
	date: string; // timestamp поста (пригодится для сортировки/фильтрации)
};

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

	async getMessagesV2(options: { channel: string; minId?: number }) {
		const { channel, minId } = options;

		const LIMIT = 20;

		const messages = await this.client.getMessages(channel, {
			limit: LIMIT,
			minId: minId,
		});

		if (messages.length === 0) {
			return { posts: [], newLastScannedId: minId };
		}

		// Фильтруем сервисные сообщения и форварды, сортируем по возрастанию id
		const realMessages = messages
			.filter((m) => m.className === "Message")
			.filter((m) => m.fwdFrom == null)
			.sort((a, b) => a.id - b.id);

		if (realMessages.length === 0) {
			// Были только сервисные сообщения / форварды — двигаем курсор, чтобы не зацикливаться
			const maxId = Math.max(...messages.map((m) => m.id));
			return { posts: [], newLastScannedId: maxId };
		}

		// Группируем подряд идущие сообщения с одинаковым groupedId
		const rawGroups: (typeof realMessages)[] = [];
		let currentGroup: typeof realMessages = [];
		let currentGroupId: string | null = null;

		for (const msg of realMessages) {
			const gid = msg.groupedId?.toString() ?? null;

			if (gid !== null && gid === currentGroupId) {
				currentGroup.push(msg);
			} else {
				if (currentGroup.length > 0) rawGroups.push(currentGroup);
				currentGroup = [msg];
				currentGroupId = gid;
			}
		}
		if (currentGroup.length > 0) rawGroups.push(currentGroup);

		// === Защита от обрезанных альбомов на ОБЕИХ границах ===
		let completeGroups = [...rawGroups];
		let droppedTailMaxId: number | null = null;

		// НИЖНЯЯ граница: первая группа может быть хвостом альбома,
		// начало которого осталось за minId предыдущего запуска.
		// Признак: это альбом (есть groupedId), но ни в одном сообщении нет текста —
		// значит caption-сообщение осталось за пределами выборки.
		if (completeGroups.length > 0) {
			const firstGroup = completeGroups[0];
			const firstGroupIsAlbum = firstGroup[0].groupedId != null;
			const hasAnyText = firstGroup.some(
				(m) => m.message && m.message.length > 0,
			);

			if (firstGroupIsAlbum && !hasAnyText) {
				droppedTailMaxId = Math.max(...firstGroup.map((m) => m.id));
				completeGroups = completeGroups.slice(1);
			}
		}

		// ВЕРХНЯЯ граница: последняя группа может быть обрезана лимитом выборки
		// (начало альбома попало в выборку, конец — нет).
		if (completeGroups.length > 0) {
			const lastGroup = completeGroups[completeGroups.length - 1];
			const lastGroupIsAlbum = lastGroup[0].groupedId != null;
			const reachedLimit = messages.length >= LIMIT;

			if (lastGroupIsAlbum && reachedLimit) {
				completeGroups = completeGroups.slice(0, -1);
			}
		}

		if (completeGroups.length === 0) {
			// Все группы оказались неполными.
			// Если отбросили хвост снизу — курсор сдвигаем за него (этот хвост уже не нужен).
			// Иначе курсор не двигаем — повторим запрос в следующий раз.
			return {
				posts: [],
				newLastScannedId: droppedTailMaxId ?? minId,
			};
		}

		// Преобразуем группы в посты
		const posts: Post[] = completeGroups.map((group) => {
			// Сообщение с текстом — это caption поста (обычно первое, но не всегда)
			const messageWithText = group.find(
				(m) => m.message && m.message.length > 0,
			);
			const text = messageWithText?.message ?? "";

			// Все сообщения, у которых есть media
			const mediaMessageIds = group
				.filter((m) => m.media != null)
				.map((m) => m.id);

			return {
				postId: group[0].id, // минимальный id в группе
				groupedId: group[0].groupedId?.toString() ?? null,
				text,
				mediaMessageIds,
				date: dayjs.unix(group[0].date).toISOString(),
			};
		});

		// Курсор — максимальный id среди всех сообщений последнего полного поста.
		// Если отбрасывали хвост на нижней границе — учитываем его id тоже,
		// чтобы в следующий раз не получить этот хвост снова.
		const lastCompleteGroup = completeGroups[completeGroups.length - 1];
		let newLastScannedId = Math.max(...lastCompleteGroup.map((m) => m.id));

		if (droppedTailMaxId !== null) {
			newLastScannedId = Math.max(newLastScannedId, droppedTailMaxId);
		}

		return { posts, newLastScannedId };
	}

	async downloadMediaToS3(options: { channel: string; messageId: number }) {
		const { channel, messageId } = options;

		const messages = await this.client.getMessages(channel, {
			ids: [messageId],
		});
		if (!messages.length) {
			throw new NotFoundException(
				"Message with provided ID was not found in this channel",
			);
		}

		const message = messages[0];
		if (!message.media) {
			throw new BadRequestException("This message is not a media message");
		}

		const s3Key = randomUUID();
		const mimeType = getMediaMimeType(message);

		// Итератор по чанкам из Telegram
		const iterator = this.client.iterDownload({
			file: message.media,
			requestSize: 512 * 1024, // опционально, размер чанка
		});

		// Превращаем async iterator в Node Readable stream
		const stream = Readable.from(iterator);

		const upload = new Upload({
			client: s3,
			params: {
				Bucket: S3_BUCKET,
				Key: s3Key,
				Body: stream,
				ContentType: mimeType,
			},
			queueSize: 4, // сколько частей грузить параллельно
			partSize: 5 * 1024 * 1024, // минимум 5 MB для multipart
		});

		await upload.done();

		return { key: s3Key, mimeType };
	}
}

function getMediaMimeType(message: Api.Message): string | undefined {
	const media = message.media;

	if (!media) return undefined;

	// Фото — у Telegram фото всегда JPEG
	if (media instanceof Api.MessageMediaPhoto) {
		return "image/jpeg";
	}

	// Документ — видео, аудио, файлы, GIF, стикеры, голосовые и т.д.
	if (media instanceof Api.MessageMediaDocument) {
		const document = media.document;
		if (document instanceof Api.Document) {
			return document.mimeType;
		}
	}

	return undefined;
}
