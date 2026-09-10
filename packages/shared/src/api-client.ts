/** Transport policy is supplied by the caller; this client never retries or consumes streams implicitly. */
export type Transport = (input: string | URL | Request, options?: RequestInit) => Promise<Response>;
export interface HttpRequest { url: string | URL | Request; options?: RequestInit }
export interface ApiAdapter<TRequest, TResponse, TContext, TError> {
  encode(request: TRequest, context: TContext): HttpRequest;
  decode(response: Response, context: TContext): TResponse | Promise<TResponse>;
  mapError(error: unknown, context: TContext): TError;
}

// Resolve fetch at call time so tests and application preloads can inject transport.
const defaultTransport: Transport = (input, options) => globalThis.fetch(input, options);

export class ApiClient<TRequest, TResponse, TContext = void, TError = unknown> {
  constructor(
    private readonly adapter: ApiAdapter<TRequest, TResponse, TContext, TError>,
    private readonly transport: Transport = defaultTransport,
  ) {}

  async request(request: TRequest, context: TContext): Promise<TResponse> {
    try {
      const { url, options } = this.adapter.encode(request, context);
      return await this.adapter.decode(await this.transport(url, options), context);
    } catch (error) { throw this.adapter.mapError(error, context); }
  }
}

/** A raw response preserves status, headers and body ownership for streaming/retry callers. */
export function createHttpClient(transportFn?: Transport) {
  const client = new ApiClient<HttpRequest, Response>({ encode: request => request, decode: response => response, mapError: error => error }, transportFn);
  return { request: (request: HttpRequest) => client.request(request, undefined) };
}
export const httpClient = createHttpClient();
