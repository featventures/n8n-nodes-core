import { createHmac, timingSafeEqual } from 'node:crypto';

/** Deliveries older (or newer) than this are rejected, as the Connect API documents. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** `sha256=` + hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`). */
export function computeSignature(
	secret: string,
	timestamp: string | number,
	rawBody: string,
): string {
	return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export type SignatureCheck =
	| { valid: true }
	| { valid: false; reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' };

/**
 * Checks `X-Core-Signature` against the raw body and refuses a timestamp outside the 5-minute
 * window. Constant-time comparison.
 */
export function verifySignature(params: {
	secret: string;
	timestamp: string | undefined;
	signature: string | undefined;
	rawBody: string;
	nowSeconds?: number;
	toleranceSeconds?: number;
}): SignatureCheck {
	const { secret, timestamp, signature, rawBody } = params;
	if (!secret || !timestamp || !signature) return { valid: false, reason: 'missing_headers' };
	const ts = Number(timestamp);
	const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
	const tolerance = params.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
	if (!Number.isFinite(ts) || Math.abs(now - ts) > tolerance) {
		return { valid: false, reason: 'stale_timestamp' };
	}
	const expected = Buffer.from(computeSignature(secret, timestamp, rawBody));
	const given = Buffer.from(String(signature).trim());
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
		return { valid: false, reason: 'bad_signature' };
	}
	return { valid: true };
}

/** First value of a header that may arrive as a string or a string array. */
export function headerValue(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) return value[0];
	return value;
}
