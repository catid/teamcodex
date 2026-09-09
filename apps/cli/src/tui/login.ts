import { panel } from './panels.ts';
import { bold, cyan, dim } from './style.ts';

export function devicePrompt(verificationUrl: string, userCode: string, width: number): string[] {
  return panel('Device login · ChatGPT', [
    '',
    ' Open this address on any device:',
    ` ${cyan(verificationUrl)}`,
    '',
    ' Enter your one-time code:',
    ` ${bold(userCode)}`,
    '',
    dim(' Waiting for authorization · expires in 15 minutes'),
    '',
  ], width, 12);
}

export function browserPrompt(url: string, width: number): string[] {
  const chunks = [];
  for (let i = 0; i < url.length; i += width - 4) chunks.push(` ${url.slice(i, i + width - 4)}`);
  const content = ['', ' Opening your browser to sign in.', ' If it does not open, visit:', '', ...chunks, '',
    ' Return here after authorizing.', ' Or paste the callback URL at the prompt below.', ''];
  return panel('Browser login · ChatGPT', content, width, content.length + 2);
}
