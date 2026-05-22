import { BadRequestException, Injectable } from "@nestjs/common";
import axios from "axios";
import * as FormData from "form-data";

const BASE_URL = process.env.TELEGRAM_BOT_API_BASE_URL as string;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;
const BOT_URL = `${BASE_URL}/bot${TELEGRAM_BOT_TOKEN}`;

type TelegramApiResponse<T> = {
	ok: boolean;
	result: T;
	description?: string;
	error_code?: number;
};

// Структура photo в ответе от sendPhoto
type TelegramPhotoSize = {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	file_size?: number;
};

type TelegramVideo = {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	duration: number;
	mime_type?: string;
};

type TelegramMessage = {
	message_id: number;
	photo?: TelegramPhotoSize[];
	video?: TelegramVideo;
};

@Injectable()
export class TelegramService {
	// ... существующие методы

	public async uploadMediaAndGetFileId(options: {
		chat_id: number;
		buffer: Buffer;
		filename: string;
		mimeType: string;
	}): Promise<string> {
		const { chat_id, buffer, filename, mimeType } = options;

		if (mimeType.startsWith("image/")) {
			return this.uploadPhotoAndGetFileId({
				chat_id,
				buffer,
				filename,
				mimeType,
			});
		}
		if (mimeType.startsWith("video/")) {
			return this.uploadVideoAndGetFileId({
				chat_id,
				buffer,
				filename,
				mimeType,
			});
		}

		throw new BadRequestException(
			`Unsupported mimeType for upload: ${mimeType}`,
		);
	}

	private async uploadPhotoAndGetFileId(options: {
		chat_id: number;
		buffer: Buffer;
		filename: string;
		mimeType: string;
	}): Promise<string> {
		const { chat_id, buffer, filename, mimeType } = options;

		const form = new FormData();
		form.append("chat_id", String(chat_id));
		form.append("photo", buffer, {
			filename,
			contentType: mimeType,
		});

		const { data } = await axios.post<TelegramApiResponse<TelegramMessage>>(
			`${BOT_URL}/sendPhoto`,
			form,
			{
				headers: form.getHeaders(),
				maxBodyLength: Infinity,
				maxContentLength: Infinity,
			},
		);

		const photos = data.result.photo;
		if (!photos || photos.length === 0) {
			throw new BadRequestException("Telegram did not return photo file_id");
		}

		// Берём самый большой размер (последний в массиве)
		const largest = photos[photos.length - 1];
		return largest.file_id;
	}

	private async uploadVideoAndGetFileId(options: {
		chat_id: number;
		buffer: Buffer;
		filename: string;
		mimeType: string;
	}): Promise<string> {
		const { chat_id, buffer, filename, mimeType } = options;

		const form = new FormData();
		form.append("chat_id", String(chat_id));
		form.append("video", buffer, {
			filename,
			contentType: mimeType,
		});
		form.append("supports_streaming", "true");

		const { data } = await axios.post<TelegramApiResponse<TelegramMessage>>(
			`${BOT_URL}/sendVideo`,
			form,
			{
				headers: form.getHeaders(),
				maxBodyLength: Infinity,
				maxContentLength: Infinity,
			},
		);

		const video = data.result.video;
		if (!video) {
			throw new BadRequestException("Telegram did not return video file_id");
		}

		return video.file_id;
	}
}
