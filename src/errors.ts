export class GatewayToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "GatewayToolError";
  }
}

export function isGatewayToolError(error: unknown): error is GatewayToolError {
  return error instanceof GatewayToolError;
}
