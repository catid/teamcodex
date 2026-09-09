import { isRecord } from './config.ts';

const EMBEDDED_429_RE = /\b(?:429|too many requests|rate.?limit|exceeded retry limit)\b/i;

export function isEmbedded429Payload(input: unknown): boolean {
  if (!isRecord(input)) return false;
  const data = input;
  const response = isRecord(data.response) ? data.response : {};

  const eventType = typeof data.type === 'string' ? data.type : '';
  const status = response.status ?? data.status;
  const hasError = Boolean(data.error || response.error);
  const has429Status = [status, data.status_code, data.statusCode]
    .some(value => value === 429 || value === '429');
  const isFailure = hasError ||
    eventType.endsWith('.failed') ||
    eventType === 'error' ||
    status === 'failed' ||
    has429Status;

  // Some backend layers surface their own retry exhaustion as a plain JSON/SSE
  // error envelope, e.g. { "detail": "exceeded retry limit, last status: 429" },
  // without setting status/error/type fields. Only inspect error-like envelope
  // fields here so normal assistant output that talks about 429s passes through.
  const envelopeText = [
    errorDetailsToText(data.detail),
    errorDetailsToText(data.message),
    errorDetailsToText(data.reason),
    errorDetailsToText(data.status_details),
    errorDetailsToText(data.statusText),
    errorDetailsToText(data.code),
  ].join(' ');

  if (!isFailure) {
    const isProgressEvent = eventType.startsWith('response.') && !eventType.endsWith('.failed');
    return !isProgressEvent && EMBEDDED_429_RE.test(envelopeText);
  }

  const text = [
    eventType,
    errorDetailsToText(data.error),
    errorDetailsToText(response.error),
    envelopeText,
    errorDetailsToText(response.status_details),
    errorDetailsToText(response.detail),
    errorDetailsToText(response.message),
    errorDetailsToText(status),
    errorDetailsToText(data.status_code),
    errorDetailsToText(data.statusCode),
  ].join(' ');

  return EMBEDDED_429_RE.test(text);
}

function errorDetailsToText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(errorDetailsToText).join(' ');
  if (!isRecord(value)) return '';

  return [
    'type',
    'code',
    'detail',
    'details',
    'error',
    'errors',
    'message',
    'reason',
    'status',
    'status_code',
    'statusCode',
    'statusText',
  ].map(key => errorDetailsToText(value[key])).join(' ');
}

