import pino from 'pino';

export const logger = pino({
  level: process.env.STORAGE_LOG_LEVEL || 'info',
  redact: ['*.secret', '*.password', '*.token', '*.url'], // redact secrets and presigned URLs
  transport: process.env.STORAGE_LOG_PRETTY
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

export function jobLogger(jobId: string, problemId?: string | null, generation?: number | null) {
  return logger.child({ job_id: jobId, problem_id: problemId ?? undefined, generation: generation ?? undefined });
}

export function requestLogger(requestId: string) {
  return logger.child({ request_id: requestId });
}