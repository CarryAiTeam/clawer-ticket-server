/** 已完成结果及其稳定输入位置、实际完成顺序。 */
export interface WorkerPoolResult<T> {
  inputIndex: number;
  completionIndex: number;
  value: T;
}

/**
 * 以固定工位数处理有限队列。
 * 本模块只负责领取和补位调度；业务处理、重试、存储和错误映射仍由调用方负责。
 */
export async function runBoundedWorkerPool<TInput, TResult>(
  inputs: readonly TInput[],
  maxWorkers: number,
  execute: (input: TInput, inputIndex: number) => Promise<TResult>,
  signal?: AbortSignal,
): Promise<WorkerPoolResult<TResult>[]> {
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1) throw new RangeError("maxWorkers must be a positive safe integer");
  let nextInput = 0;
  let nextCompletion = 0;
  let stopError: unknown;
  const results: WorkerPoolResult<TResult>[] = [];
  const worker = async () => {
    for (;;) {
      if (signal?.aborted || stopError !== undefined || nextInput >= inputs.length) return;
      const inputIndex = nextInput++;
      try {
        const value = await execute(inputs[inputIndex]!, inputIndex);
        results.push({ inputIndex, completionIndex: nextCompletion++, value });
      } catch (error) {
        // Stop replacement work and wait for all in-flight workers before the
        // caller can retry an operation (notably after authorization recovery).
        stopError ??= error;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxWorkers, inputs.length) }, worker));
  if (stopError !== undefined) throw stopError;
  return results;
}
