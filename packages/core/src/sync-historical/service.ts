import type { Common } from "@/common/common.js";
import { getHistoricalSyncProgress } from "@/common/metrics.js";
import type { Network } from "@/config/networks.js";
import type {
  BlockSource,
  EventSource,
  FactorySource,
  FunctionCallSource,
  LogFilterCriteria,
  LogSource,
} from "@/config/sources.js";
import type { SyncStore } from "@/sync-store/store.js";
import { type Checkpoint, maxCheckpoint } from "@/utils/checkpoint.js";
import { formatEta, formatPercentage } from "@/utils/format.js";
import {
  BlockProgressTracker,
  ProgressTracker,
  getChunks,
  intervalDifference,
  intervalIntersection,
  intervalSum,
} from "@/utils/interval.js";
import { toLowerCase } from "@/utils/lowercase.js";
import { never } from "@/utils/never.js";
import { type Queue, type Worker, createQueue } from "@/utils/queue.js";
import type { RequestQueue } from "@/utils/requestQueue.js";
import { debounce } from "@ponder/common";
import Emittery from "emittery";
import {
  type Address,
  BlockNotFoundError,
  type Hash,
  type Hex,
  type LogTopic,
  type RpcBlock,
  type RpcLog,
  type RpcTransaction,
  type RpcTransactionReceipt,
  TransactionReceiptNotFoundError,
  hexToNumber,
  numberToHex,
  toHex,
} from "viem";
import { validateHistoricalBlockRange } from "./validateHistoricalBlockRange.js";

const HISTORICAL_CHECKPOINT_EMIT_INTERVAL = 500;

type HistoricalSyncEvents = {
  /**
   * Emitted when the service has finished processing all historical sync tasks.
   */
  syncComplete: undefined;
  /**
   * Emitted when the minimum cached timestamp among all registered sources moves forward.
   * This indicates to consumers that the connected sync store now contains a complete history
   * of events for all registered sources between their start block and this timestamp (inclusive).
   */
  historicalCheckpoint: Checkpoint;
};

type LogFilterTask = {
  kind: "LOG_FILTER";
  logFilter: LogSource;
  fromBlock: number;
  toBlock: number;
};

type FactoryChildAddressTask = {
  kind: "FACTORY_CHILD_ADDRESS";
  factory: FactorySource;
  fromBlock: number;
  toBlock: number;
};

type FactoryLogFilterTask = {
  kind: "FACTORY_LOG_FILTER";
  factory: FactorySource;
  fromBlock: number;
  toBlock: number;
};

type BlockFilterTask = {
  kind: "BLOCK_FILTER";
  blockFilter: BlockSource;
  fromBlock: number;
  toBlock: number;
};

type TraceFilterTask = {
  kind: "TRACE_FILTER";
  traceFilter: FunctionCallSource;
  fromBlock: number;
  toBlock: number;
};

type BlockTask = {
  kind: "BLOCK";
  blockNumber: number;
  callbacks: ((block: HistoricalBlock) => Promise<void>)[];
};

type HistoricalSyncTask =
  | LogFilterTask
  | FactoryChildAddressTask
  | FactoryLogFilterTask
  | BlockFilterTask
  | BlockTask
  | TraceFilterTask;

type HistoricalBlock = RpcBlock<"finalized", true>;
type HistoricalTransaction = RpcTransaction<false>;

type LogInterval = {
  startBlock: number;
  endBlock: number;
  logs: RpcLog[];
};

export class HistoricalSyncService extends Emittery<HistoricalSyncEvents> {
  private common: Common;
  private syncStore: SyncStore;
  private network: Network;
  private requestQueue: RequestQueue;
  private sources: EventSource[];

  /**
   * Block progress trackers for each task type.
   */
  private logFilterProgressTrackers: Record<string, ProgressTracker> = {};
  private factoryChildAddressProgressTrackers: Record<string, ProgressTracker> =
    {};
  private factoryLogFilterProgressTrackers: Record<string, ProgressTracker> =
    {};
  private blockFilterProgressTrackers: Record<string, ProgressTracker> = {};
  private traceFilterProgressTrackers: Record<string, ProgressTracker> = {};

  private blockProgressTracker: BlockProgressTracker =
    new BlockProgressTracker();

  /**
   * Functions registered by log filter + child contract tasks. These functions accept
   * a raw block object, get required data from it, then insert data and cache metadata
   * into the sync store. The keys of this object are used to keep track of which blocks
   * must be fetched.
   */
  private blockCallbacks: Record<
    number,
    ((block: HistoricalBlock) => Promise<void>)[]
  > = {};

  /**
   * Block tasks have been added to the queue up to and including this block number.
   * Used alongside blockCallbacks to keep track of which block tasks to add to the queue.
   */
  private blockTasksEnqueuedCheckpoint = 0;

  private queue: Queue<HistoricalSyncTask>;

  /** If true, failed tasks should not log errors or be retried. */
  private isShuttingDown = false;
  private progressLogInterval?: NodeJS.Timeout;

  constructor({
    common,
    syncStore,
    network,
    requestQueue,
    sources = [],
  }: {
    common: Common;
    syncStore: SyncStore;
    network: Network;
    requestQueue: RequestQueue;
    sources?: EventSource[];
  }) {
    super();

    this.common = common;
    this.syncStore = syncStore;
    this.network = network;
    this.requestQueue = requestQueue;
    this.sources = sources;

    this.queue = this.buildQueue();
  }

  async setup({
    latestBlockNumber,
    finalizedBlockNumber,
  }: {
    latestBlockNumber: number;
    finalizedBlockNumber: number;
  }) {
    // Initialize state variables. Required when restarting the service.
    this.isShuttingDown = false;
    this.blockTasksEnqueuedCheckpoint = 0;

    await Promise.all(
      this.sources.map(async (source) => {
        const { isHistoricalSyncRequired, startBlock, endBlock } =
          validateHistoricalBlockRange({
            startBlock: source.startBlock,
            endBlock: source.endBlock,
            finalizedBlockNumber,
            latestBlockNumber,
          });

        switch (source.type) {
          case "log": {
            // Log filter
            if (!isHistoricalSyncRequired) {
              this.logFilterProgressTrackers[source.id] = new ProgressTracker({
                target: [startBlock, finalizedBlockNumber],
                completed: [[startBlock, finalizedBlockNumber]],
              });
              this.common.metrics.ponder_historical_total_blocks.set(
                { network: this.network.name, source: source.contractName },
                0,
              );
              this.common.logger.warn({
                service: "historical",
                msg: `Start block is in unfinalized range, skipping historical sync (contract=${source.id})`,
              });
              return;
            }

            const completedLogFilterIntervals =
              await this.syncStore.getLogFilterIntervals({
                chainId: source.chainId,
                logFilter: source.criteria,
              });
            const logFilterProgressTracker = new ProgressTracker({
              target: [startBlock, endBlock],
              completed: completedLogFilterIntervals,
            });
            this.logFilterProgressTrackers[source.id] =
              logFilterProgressTracker;

            const requiredLogFilterIntervals =
              logFilterProgressTracker.getRequired();

            const logFilterTaskChunks = getChunks({
              intervals: requiredLogFilterIntervals,
              maxChunkSize:
                source.maxBlockRange ?? this.network.defaultMaxBlockRange,
            });

            for (const [fromBlock, toBlock] of logFilterTaskChunks) {
              this.queue.addTask(
                {
                  kind: "LOG_FILTER",
                  logFilter: source,
                  fromBlock,
                  toBlock,
                },
                { priority: Number.MAX_SAFE_INTEGER - fromBlock },
              );
            }
            if (logFilterTaskChunks.length > 0) {
              const total = intervalSum(requiredLogFilterIntervals);
              this.common.logger.debug({
                service: "historical",
                msg: `Added LOG_FILTER tasks for ${total}-block range (contract=${source.contractName}, network=${this.network.name})`,
              });
            }

            const targetBlockCount = endBlock - startBlock + 1;
            const cachedBlockCount =
              targetBlockCount - intervalSum(requiredLogFilterIntervals);

            this.common.metrics.ponder_historical_total_blocks.set(
              { network: this.network.name, source: source.contractName },
              targetBlockCount,
            );
            this.common.metrics.ponder_historical_cached_blocks.set(
              { network: this.network.name, source: source.contractName },
              cachedBlockCount,
            );

            this.common.logger.info({
              service: "historical",
              msg: `Started sync with ${formatPercentage(
                Math.min(1, cachedBlockCount / (targetBlockCount || 1)),
              )} cached (contract=${source.contractName}, network=${
                this.network.name
              })`,
            });
          }
          break;

          case "factory": {
            // Factory
            if (!isHistoricalSyncRequired) {
              this.factoryChildAddressProgressTrackers[source.id] =
                new ProgressTracker({
                  target: [startBlock, finalizedBlockNumber],
                  completed: [[startBlock, finalizedBlockNumber]],
                });
              this.factoryLogFilterProgressTrackers[source.id] =
                new ProgressTracker({
                  target: [startBlock, finalizedBlockNumber],
                  completed: [[startBlock, finalizedBlockNumber]],
                });
              this.common.metrics.ponder_historical_total_blocks.set(
                { network: this.network.name, source: source.contractName },
                0,
              );
              this.common.logger.warn({
                service: "historical",
                msg: `Start block is in unfinalized range, skipping historical sync (contract=${source.contractName})`,
              });
              return;
            }

            // Note that factory child address progress is stored using
            // log intervals for the factory log.
            const completedFactoryChildAddressIntervals =
              await this.syncStore.getLogFilterIntervals({
                chainId: source.chainId,
                logFilter: {
                  address: source.criteria.address,
                  topics: [source.criteria.eventSelector],
                  includeTransactionReceipts: false,
                },
              });
            const factoryChildAddressProgressTracker = new ProgressTracker({
              target: [startBlock, endBlock],
              completed: completedFactoryChildAddressIntervals,
            });
            this.factoryChildAddressProgressTrackers[source.id] =
              factoryChildAddressProgressTracker;

            const requiredFactoryChildAddressIntervals =
              factoryChildAddressProgressTracker.getRequired();
            const factoryChildAddressTaskChunks = getChunks({
              intervals: requiredFactoryChildAddressIntervals,
              maxChunkSize:
                source.maxBlockRange ?? this.network.defaultMaxBlockRange,
            });

            for (const [fromBlock, toBlock] of factoryChildAddressTaskChunks) {
              this.queue.addTask(
                {
                  kind: "FACTORY_CHILD_ADDRESS",
                  factory: source,
                  fromBlock,
                  toBlock,
                },
                { priority: Number.MAX_SAFE_INTEGER - fromBlock },
              );
            }
            if (factoryChildAddressTaskChunks.length > 0) {
              const total = intervalSum(requiredFactoryChildAddressIntervals);
              this.common.logger.debug({
                service: "historical",
                msg: `Added FACTORY_CHILD_ADDRESS tasks for ${total}-block range (factory=${source.id}, network=${this.network.name})`,
              });
            }

            const targetFactoryChildAddressBlockCount =
              endBlock - startBlock + 1;
            const cachedFactoryChildAddressBlockCount =
              targetFactoryChildAddressBlockCount -
              intervalSum(requiredFactoryChildAddressIntervals);

            this.common.metrics.ponder_historical_total_blocks.set(
              {
                network: this.network.name,
                source: `${source.contractName}_factory`,
              },
              targetFactoryChildAddressBlockCount,
            );
            this.common.metrics.ponder_historical_cached_blocks.set(
              {
                network: this.network.name,
                source: `${source.contractName}_factory`,
              },
              cachedFactoryChildAddressBlockCount,
            );

            const completedFactoryLogFilterIntervals =
              await this.syncStore.getFactoryLogFilterIntervals({
                chainId: source.chainId,
                factory: source.criteria,
              });
            const factoryLogFilterProgressTracker = new ProgressTracker({
              target: [startBlock, endBlock],
              completed: completedFactoryLogFilterIntervals,
            });
            this.factoryLogFilterProgressTrackers[source.id] =
              factoryLogFilterProgressTracker;

            // Only add factory log filter tasks for any intervals where the
            // child address tasks are completed, but the factory log filter tasks are not,
            // because these won't be added automatically by child address tasks.
            const requiredFactoryLogFilterIntervals =
              factoryLogFilterProgressTracker.getRequired();
            const missingFactoryLogFilterIntervals = intervalDifference(
              requiredFactoryLogFilterIntervals,
              requiredFactoryChildAddressIntervals,
            );

            const missingFactoryLogFilterTaskChunks = getChunks({
              intervals: missingFactoryLogFilterIntervals,
              maxChunkSize:
                source.maxBlockRange ?? this.network.defaultMaxBlockRange,
            });

            for (const [
              fromBlock,
              toBlock,
            ] of missingFactoryLogFilterTaskChunks) {
              this.queue.addTask(
                {
                  kind: "FACTORY_LOG_FILTER",
                  factory: source,
                  fromBlock,
                  toBlock,
                },
                { priority: Number.MAX_SAFE_INTEGER - fromBlock },
              );
            }
            if (missingFactoryLogFilterTaskChunks.length > 0) {
              const total = intervalSum(missingFactoryLogFilterIntervals);
              this.common.logger.debug({
                service: "historical",
                msg: `Added FACTORY_LOG_FILTER tasks for ${total}-block range (contract=${source.contractName}, network=${this.network.name})`,
              });
            }

            const targetFactoryLogFilterBlockCount = endBlock - startBlock + 1;
            const cachedFactoryLogFilterBlockCount =
              targetFactoryLogFilterBlockCount -
              intervalSum(requiredFactoryLogFilterIntervals);

            this.common.metrics.ponder_historical_total_blocks.set(
              { network: this.network.name, source: source.contractName },
              targetFactoryLogFilterBlockCount,
            );
            this.common.metrics.ponder_historical_cached_blocks.set(
              { network: this.network.name, source: source.contractName },
              cachedFactoryLogFilterBlockCount,
            );

            // Use factory log filter progress for the logger because it better represents
            // user-facing progress.
            const cacheRate = Math.min(
              1,
              cachedFactoryLogFilterBlockCount /
                (targetFactoryLogFilterBlockCount || 1),
            );
            this.common.logger.info({
              service: "historical",
              msg: `Started sync with ${formatPercentage(
                cacheRate,
              )} cached (contract=${source.contractName}, network=${
                this.network.name
              })`,
            });
          }
          break;

          case "block": {
            // Block filter
            if (!isHistoricalSyncRequired) {
              this.blockFilterProgressTrackers[source.id] = new ProgressTracker(
                {
                  target: [startBlock, finalizedBlockNumber],
                  completed: [[startBlock, finalizedBlockNumber]],
                },
              );
              this.common.metrics.ponder_historical_total_blocks.set(
                { network: this.network.name, source: source.sourceName },
                0,
              );
              this.common.logger.warn({
                service: "historical",
                msg: `Start block is in unfinalized range, skipping historical sync (contract=${source.id})`,
              });
              return;
            }

            const completedBlockFilterIntervals =
              await this.syncStore.getBlockFilterIntervals({
                chainId: source.chainId,
                blockFilter: source.criteria,
              });
            const blockFilterProgressTracker = new ProgressTracker({
              target: [startBlock, endBlock],
              completed: completedBlockFilterIntervals,
            });
            this.blockFilterProgressTrackers[source.id] =
              blockFilterProgressTracker;

            const requiredBlockFilterIntervals =
              blockFilterProgressTracker.getRequired();

            // block filters are chunked into intervals to avoid unmanageable
            // amounts of block callbacks being added at once.

            const blockFilterTaskChunks = getChunks({
              intervals: requiredBlockFilterIntervals,
              maxChunkSize: this.network.defaultMaxBlockRange,
            });

            for (const [fromBlock, toBlock] of blockFilterTaskChunks) {
              this.queue.addTask(
                {
                  kind: "BLOCK_FILTER",
                  blockFilter: source,
                  fromBlock,
                  toBlock,
                },
                { priority: Number.MAX_SAFE_INTEGER - fromBlock },
              );
            }
            if (blockFilterTaskChunks.length > 0) {
              const total = intervalSum(requiredBlockFilterIntervals);
              this.common.logger.debug({
                service: "historical",
                msg: `Added BLOCK_FILTER tasks for ${total}-block range (network=${this.network.name})`,
              });
            }

            const targetBlockCount = endBlock - startBlock + 1;
            const cachedBlockCount =
              targetBlockCount - intervalSum(requiredBlockFilterIntervals);

            this.common.metrics.ponder_historical_total_blocks.set(
              { network: this.network.name, source: source.sourceName },
              targetBlockCount,
            );
            this.common.metrics.ponder_historical_cached_blocks.set(
              { network: this.network.name, source: source.sourceName },
              cachedBlockCount,
            );

            this.common.logger.info({
              service: "historical",
              msg: `Started sync with ${formatPercentage(
                Math.min(1, cachedBlockCount / (targetBlockCount || 1)),
              )} cached (network=${this.network.name})`,
            });
          }
          break;

          case "function": {
            // Trace filter
            if (!isHistoricalSyncRequired) {
              this.traceFilterProgressTrackers[source.id] = new ProgressTracker(
                {
                  target: [startBlock, finalizedBlockNumber],
                  completed: [[startBlock, finalizedBlockNumber]],
                },
              );
              this.common.metrics.ponder_historical_total_blocks.set(
                { network: this.network.name, source: source.contractName },
                0,
              );
              this.common.logger.warn({
                service: "historical",
                msg: `Start block is in unfinalized range, skipping historical sync (contract=${source.id})`,
              });
              return;
            }

            const completedTraceFilterIntervals =
              await this.syncStore.getTraceFilterIntervals({
                chainId: source.chainId,
                traceFilter: source.criteria,
              });
            const traceFilterProgressTracker = new ProgressTracker({
              target: [startBlock, endBlock],
              completed: completedTraceFilterIntervals,
            });
            this.traceFilterProgressTrackers[source.id] =
              traceFilterProgressTracker;

            const requiredTraceFilterIntervals =
              traceFilterProgressTracker.getRequired();

            const traceFilterTaskChunks = getChunks({
              intervals: requiredTraceFilterIntervals,
              maxChunkSize:
                source.maxBlockRange ?? this.network.defaultMaxBlockRange,
            });

            for (const [fromBlock, toBlock] of traceFilterTaskChunks) {
              this.queue.addTask(
                {
                  kind: "TRACE_FILTER",
                  traceFilter: source,
                  fromBlock,
                  toBlock,
                },
                { priority: Number.MAX_SAFE_INTEGER - fromBlock },
              );
            }
            if (traceFilterTaskChunks.length > 0) {
              const total = intervalSum(requiredTraceFilterIntervals);
              this.common.logger.debug({
                service: "historical",
                msg: `Added TRACE_FILTER tasks for ${total}-block range (contract=${source.contractName}, network=${this.network.name})`,
              });
            }

            const targetBlockCount = endBlock - startBlock + 1;
            const cachedBlockCount =
              targetBlockCount - intervalSum(requiredTraceFilterIntervals);

            // TODO(kyle) contract name is not a unique identifier
            this.common.metrics.ponder_historical_total_blocks.set(
              { network: this.network.name, source: source.contractName },
              targetBlockCount,
            );
            this.common.metrics.ponder_historical_cached_blocks.set(
              { network: this.network.name, source: source.contractName },
              cachedBlockCount,
            );

            // TODO(kyle) contract name is not a unique identifier
            this.common.logger.info({
              service: "historical",
              msg: `Started sync with ${formatPercentage(
                Math.min(1, cachedBlockCount / (targetBlockCount || 1)),
              )} cached (contract=${source.contractName}, network=${
                this.network.name
              })`,
            });
          }
          break;

          default:
            never(source);
        }
      }),
    );
  }

  start() {
    this.common.metrics.ponder_historical_start_timestamp.set(Date.now());

    // Emit status update logs on an interval for each active log filter.
    this.progressLogInterval = setInterval(async () => {
      const historical = await getHistoricalSyncProgress(this.common.metrics);

      historical.sources.forEach(({ sourceName, progress, eta }) => {
        if (progress === 1) return;
        this.common.logger.info({
          service: "historical",
          msg: `Sync is ${formatPercentage(progress ?? 0)} complete${
            eta !== undefined ? ` with ~${formatEta(eta)} remaining` : ""
          } (source=${sourceName}, network=${this.network.name})`,
          network: this.network.name,
        });
      });
    }, 10_000);

    // Edge case: If there are no tasks in the queue, this means the entire
    // requested range was cached, so the sync is complete.
    if (this.queue.size === 0) {
      clearInterval(this.progressLogInterval);
      this.common.logger.info({
        service: "historical",
        msg: `Completed sync (network=${this.network.name})`,
        network: this.network.name,
      });
      this.emit("syncComplete");
    }

    this.queue.start();
  }

  kill = () => {
    this.isShuttingDown = true;
    clearInterval(this.progressLogInterval);
    this.queue.pause();
    this.queue.clear();
    this.common.logger.debug({
      service: "historical",
      msg: `Killed historical sync service (network=${this.network.name})`,
    });
  };

  onIdle = () =>
    new Promise((resolve) =>
      setImmediate(() => this.queue.onIdle().then(resolve)),
    );

  private buildQueue = () => {
    const worker: Worker<HistoricalSyncTask> = async ({ task, queue }) => {
      switch (task.kind) {
        case "LOG_FILTER": {
          await this.logFilterTaskWorker(task);
          break;
        }
        case "FACTORY_CHILD_ADDRESS": {
          await this.factoryChildAddressTaskWorker(task);
          break;
        }
        case "FACTORY_LOG_FILTER": {
          await this.factoryLogFilterTaskWorker(task);
          break;
        }
        case "BLOCK_FILTER": {
          await this.blockFilterTaskWorker(task);
          break;
        }
        case "BLOCK": {
          await this.blockTaskWorker(task);
          break;
        }
        case "TRACE_FILTER": {
          // TODO(kyle)
          break;
        }

        default:
          never(task);
      }

      // If this is not the final task, return.
      if (queue.size > 0 || queue.pending > 1) return;
      // If this is the final task but the kill() method has been called, do nothing.
      if (this.isShuttingDown) return;

      // If this is the final task, run the cleanup/completion logic.
      clearInterval(this.progressLogInterval);
      const startTimestamp =
        (await this.common.metrics.ponder_historical_start_timestamp.get())
          .values?.[0]?.value ?? Date.now();
      const duration = Date.now() - startTimestamp;
      this.common.logger.info({
        service: "historical",
        msg: `Completed sync in ${formatEta(duration)} (network=${
          this.network.name
        })`,
      });
      this.emit("syncComplete");
    };

    const queue = createQueue<HistoricalSyncTask>({
      worker,
      options: {
        concurrency: this.network.maxHistoricalTaskConcurrency,
        autoStart: false,
      },
      onError: ({ error, task, queue }) => {
        if (this.isShuttingDown) return;

        switch (task.kind) {
          case "LOG_FILTER": {
            this.common.logger.warn({
              service: "historical",
              msg: `Log filter task failed, retrying... [${task.fromBlock}, ${
                task.toBlock
              }] (contract=${task.logFilter.contractName}, network=${
                this.network.name
              }, error=${`${error.name}: ${error.message}`})`,
            });
            const priority = Number.MAX_SAFE_INTEGER - task.fromBlock;
            queue.addTask({ ...task }, { priority });
            break;
          }
          case "FACTORY_CHILD_ADDRESS": {
            this.common.logger.warn({
              service: "historical",
              msg: `Factory child address task failed, retrying... [${
                task.fromBlock
              }, ${task.toBlock}] (contract=${
                task.factory.contractName
              }, network=${
                this.network.name
              }, error=${`${error.name}: ${error.message}`})`,
            });
            const priority = Number.MAX_SAFE_INTEGER - task.fromBlock;
            queue.addTask({ ...task }, { priority });
            break;
          }
          case "FACTORY_LOG_FILTER": {
            this.common.logger.warn({
              service: "historical",
              msg: `Factory log filter task failed, retrying... [${
                task.fromBlock
              }, ${task.toBlock}] (contract=${
                task.factory.contractName
              }, network=${
                this.network.name
              }, error=${`${error.name}: ${error.message}`})`,
            });
            const priority = Number.MAX_SAFE_INTEGER - task.fromBlock;
            queue.addTask({ ...task }, { priority });
            break;
          }
          case "BLOCK": {
            this.common.logger.warn({
              service: "historical",
              msg: `Block task failed, retrying... [${
                task.blockNumber
              }] (network=${
                this.network.name
              }, error=${`${error.name}: ${error.message}`})`,
            });
            const priority = Number.MAX_SAFE_INTEGER - task.blockNumber;
            queue.addTask({ ...task }, { priority });
            break;
          }
          case "BLOCK_FILTER": {
            this.common.logger.warn({
              service: "historical",
              msg: `Block filter task failed, retrying... [${task.fromBlock}, ${
                task.toBlock
              }] (source=${task.blockFilter.sourceName}, network=${
                this.network.name
              }, error=${`${error.name}: ${error.message}`})`,
            });
            const priority = Number.MAX_SAFE_INTEGER - task.fromBlock;
            queue.addTask({ ...task }, { priority });
            break;
          }
          case "TRACE_FILTER": {
            this.common.logger.warn({
              service: "historical",
              msg: `Trace filter task failed, retrying... [${task.fromBlock}, ${
                task.toBlock
              }] (contract=${task.traceFilter.contractName}, network=${
                this.network.name
              }, error=${`${error.name}: ${error.message}`})`,
            });
            const priority = Number.MAX_SAFE_INTEGER - task.fromBlock;
            queue.addTask({ ...task }, { priority });
            break;
          }

          default:
            never(task);
        }
      },
    });

    return queue;
  };

  private logFilterTaskWorker = async ({
    logFilter,
    fromBlock,
    toBlock,
  }: LogFilterTask) => {
    const logs = await this._eth_getLogs({
      address: logFilter.criteria.address,
      topics: logFilter.criteria.topics,
      fromBlock: toHex(fromBlock),
      toBlock: toHex(toBlock),
    });
    const logIntervals = this.buildLogIntervals({ fromBlock, toBlock, logs });

    for (const logInterval of logIntervals) {
      const { startBlock, endBlock } = logInterval;

      if (this.blockCallbacks[endBlock] === undefined)
        this.blockCallbacks[endBlock] = [];

      this.blockCallbacks[endBlock].push(async (block) => {
        const { transactionHashes } = logInterval;
        const transactions = block.transactions.filter((tx) =>
          transactionHashes.has(tx.hash),
        );
        const transactionReceipts =
          logFilter.criteria.includeTransactionReceipts === true
            ? await Promise.all(
                transactions.map((tx) =>
                  this._eth_getTransactionReceipt({ hash: tx.hash }),
                ),
              )
            : [];

        await this._insertLogFilterInterval({
          logInterval,
          logFilter: logFilter.criteria,
          chainId: logFilter.chainId,
          block,
          transactions,
          transactionReceipts,
        });

        this.common.metrics.ponder_historical_completed_blocks.inc(
          { network: this.network.name, source: logFilter.contractName },
          endBlock - startBlock + 1,
        );
      });
    }

    this.logFilterProgressTrackers[logFilter.id].addCompletedInterval([
      fromBlock,
      toBlock,
    ]);

    this.enqueueBlockTasks();

    this.common.logger.trace({
      service: "historical",
      msg: `Completed LOG_FILTER task adding ${logIntervals.length} BLOCK tasks [${fromBlock}, ${toBlock}] (contract=${logFilter.contractName}, network=${this.network.name})`,
    });
  };

  private factoryLogFilterTaskWorker = async ({
    factory,
    fromBlock,
    toBlock,
  }: FactoryLogFilterTask) => {
    const iterator = this.syncStore.getFactoryChildAddresses({
      chainId: factory.chainId,
      factory: factory.criteria,
      fromBlock: BigInt(factory.startBlock),
      toBlock: BigInt(toBlock),
    });

    const logs: RpcLog[] = [];
    for await (const childContractAddressBatch of iterator) {
      const _logs = await this._eth_getLogs({
        address: childContractAddressBatch,
        topics: factory.criteria.topics,
        fromBlock: numberToHex(fromBlock),
        toBlock: numberToHex(toBlock),
      });
      logs.push(..._logs);
    }

    const logIntervals = this.buildLogIntervals({ fromBlock, toBlock, logs });

    for (const logInterval of logIntervals) {
      const { startBlock, endBlock, logs, transactionHashes } = logInterval;

      if (this.blockCallbacks[endBlock] === undefined)
        this.blockCallbacks[endBlock] = [];

      this.blockCallbacks[endBlock].push(async (block) => {
        const transactions = block.transactions.filter((tx) =>
          transactionHashes.has(tx.hash),
        );
        const transactionReceipts =
          factory.criteria.includeTransactionReceipts === true
            ? await Promise.all(
                transactions.map((tx) =>
                  this._eth_getTransactionReceipt({ hash: tx.hash }),
                ),
              )
            : [];

        await this.syncStore.insertFactoryLogFilterInterval({
          chainId: factory.chainId,
          factory: factory.criteria,
          block,
          transactions,
          transactionReceipts,
          logs,
          interval: {
            startBlock: BigInt(startBlock),
            endBlock: BigInt(endBlock),
          },
        });

        this.common.metrics.ponder_historical_completed_blocks.inc(
          { network: this.network.name, source: factory.contractName },
          endBlock - startBlock + 1,
        );
      });
    }

    this.factoryLogFilterProgressTrackers[factory.id].addCompletedInterval([
      fromBlock,
      toBlock,
    ]);

    this.enqueueBlockTasks();

    this.common.logger.trace({
      service: "historical",
      msg: `Completed FACTORY_LOG_FILTER task adding ${logIntervals.length} BLOCK tasks [${fromBlock}, ${toBlock}] (contract=${factory.contractName}, network=${this.network.name})`,
    });
  };

  private factoryChildAddressTaskWorker = async ({
    factory,
    fromBlock,
    toBlock,
  }: FactoryChildAddressTask) => {
    const logs = await this._eth_getLogs({
      address: factory.criteria.address,
      topics: [factory.criteria.eventSelector],
      fromBlock: toHex(fromBlock),
      toBlock: toHex(toBlock),
    });

    // Insert the new child address logs into the store.
    await this.syncStore.insertFactoryChildAddressLogs({
      chainId: factory.chainId,
      logs,
    });

    // Register block callbacks for the child address logs. This is how
    // the intervals will be recorded (marking the child address logs as
    // cached on subsequent starts).
    const logIntervals = this.buildLogIntervals({ fromBlock, toBlock, logs });
    for (const logInterval of logIntervals) {
      if (this.blockCallbacks[logInterval.endBlock] === undefined)
        this.blockCallbacks[logInterval.endBlock] = [];

      this.blockCallbacks[logInterval.endBlock].push(async (block) => {
        const { transactionHashes } = logInterval;

        const transactions = block.transactions.filter((tx) =>
          transactionHashes.has(tx.hash),
        );

        await this._insertLogFilterInterval({
          logInterval,
          logFilter: {
            address: factory.criteria.address,
            topics: [factory.criteria.eventSelector],
            includeTransactionReceipts: false,
          },
          chainId: factory.chainId,
          block,
          transactions,
          transactionReceipts: [],
        });
      });
    }

    // Update the checkpoint, and if necessary, enqueue factory log filter tasks.
    const { isUpdated, prevCheckpoint, newCheckpoint } =
      this.factoryChildAddressProgressTrackers[factory.id].addCompletedInterval(
        [fromBlock, toBlock],
      );
    if (isUpdated) {
      // It's possible for the factory log filter to have already completed some or
      // all of the block interval here. To avoid duplicates, only add intervals that
      // are still marked as required.
      const requiredIntervals = intervalIntersection(
        [[prevCheckpoint + 1, newCheckpoint]],
        this.factoryLogFilterProgressTrackers[factory.id].getRequired(),
      );
      const factoryLogFilterChunks = getChunks({
        intervals: requiredIntervals,
        maxChunkSize:
          factory.maxBlockRange ?? this.network.defaultMaxBlockRange,
      });

      for (const [fromBlock, toBlock] of factoryLogFilterChunks) {
        this.queue.addTask(
          { kind: "FACTORY_LOG_FILTER", factory, fromBlock, toBlock },
          { priority: Number.MAX_SAFE_INTEGER - fromBlock },
        );
      }
    }
    this.common.metrics.ponder_historical_completed_blocks.inc(
      {
        network: this.network.name,
        source: `${factory.contractName}_factory`,
      },
      toBlock - fromBlock + 1,
    );

    this.common.logger.trace({
      service: "historical",
      msg: `Completed FACTORY_CHILD_ADDRESS task [${fromBlock}, ${toBlock}] (contract=${factory.contractName}, network=${this.network.name})`,
    });
  };

  private blockFilterTaskWorker = async ({
    blockFilter,
    fromBlock,
    toBlock,
  }: BlockFilterTask) => {
    const baseOffset =
      (fromBlock - blockFilter.criteria.offset) % blockFilter.criteria.interval;
    const offset =
      baseOffset === 0 ? 0 : blockFilter.criteria.interval - baseOffset;

    // Determine which blocks are matched by the block filter, and add a callback for
    // each block. A block callback, and subsequent "eth_getBlock" request can be
    // skipped if the block is already present in the database.

    const requiredBlocks: number[] = [];
    for (
      let blockNumber = fromBlock + offset;
      blockNumber <= toBlock;
      blockNumber += blockFilter.criteria.interval
    ) {
      requiredBlocks.push(blockNumber);
    }

    // If toBlock is not already required, add it. This is necessary
    // to mark the full block range of the eth_getLogs request as cached.
    if (!requiredBlocks.includes(toBlock)) {
      requiredBlocks.push(toBlock);
    }

    let prevBlockNumber = fromBlock;
    for (const blockNumber of requiredBlocks) {
      const hasBlock = await this.syncStore.getBlock({
        chainId: blockFilter.chainId,
        blockNumber,
      });

      const startBlock = prevBlockNumber;
      const endBlock = blockNumber;

      if (hasBlock) {
        await this.syncStore.insertBlockFilterInterval({
          chainId: blockFilter.chainId,
          blockFilter: blockFilter.criteria,
          interval: {
            startBlock: BigInt(startBlock),
            endBlock: BigInt(endBlock),
          },
        });

        this.common.metrics.ponder_historical_completed_blocks.inc(
          { network: this.network.name, source: blockFilter.sourceName },
          endBlock - startBlock + 1,
        );
      } else {
        if (this.blockCallbacks[blockNumber] === undefined)
          this.blockCallbacks[blockNumber] = [];

        this.blockCallbacks[blockNumber].push(async (block) => {
          await this.syncStore.insertBlockFilterInterval({
            chainId: blockFilter.chainId,
            blockFilter: blockFilter.criteria,
            block,
            interval: {
              startBlock: BigInt(startBlock),
              endBlock: BigInt(endBlock),
            },
          });

          this.common.metrics.ponder_historical_completed_blocks.inc(
            { network: this.network.name, source: blockFilter.sourceName },
            endBlock - startBlock + 1,
          );
        });
      }

      prevBlockNumber = blockNumber + 1;
    }

    this.blockFilterProgressTrackers[blockFilter.id].addCompletedInterval([
      fromBlock,
      toBlock,
    ]);

    this.enqueueBlockTasks();

    this.common.logger.trace({
      service: "historical",
      msg: `Completed BLOCK_FILTER task [${fromBlock}, ${toBlock}] ( network=${this.network.name})`,
    });
  };

  private blockTaskWorker = async ({ blockNumber, callbacks }: BlockTask) => {
    const block = await this._eth_getBlockByNumber({
      blockNumber,
    });

    for (const callback of callbacks) {
      await callback(block);
    }

    const newBlockCheckpoint = this.blockProgressTracker.addCompletedBlock({
      blockNumber,
      blockTimestamp: hexToNumber(block.timestamp),
    });

    if (newBlockCheckpoint) {
      this.debouncedEmitCheckpoint.call({
        ...maxCheckpoint,
        blockTimestamp: newBlockCheckpoint.blockTimestamp,
        chainId: BigInt(this.network.chainId),
        blockNumber: BigInt(newBlockCheckpoint.blockNumber),
      });
    }

    this.common.logger.trace({
      service: "historical",
      msg: `Completed BLOCK task ${hexToNumber(block.number!)} with ${
        callbacks.length
      } callbacks (network=${this.network.name})`,
    });
  };

  private buildLogIntervals = ({
    fromBlock,
    toBlock,
    logs,
  }: {
    fromBlock: number;
    toBlock: number;
    logs: RpcLog[];
  }) => {
    const logsByBlockNumber: Record<number, RpcLog[] | undefined> = {};
    const txHashesByBlockNumber: Record<number, Set<Hash> | undefined> = {};

    logs.forEach((log) => {
      const blockNumber = hexToNumber(log.blockNumber!);
      (txHashesByBlockNumber[blockNumber] ||= new Set<Hash>()).add(
        log.transactionHash!,
      );
      (logsByBlockNumber[blockNumber] ||= []).push(log);
    });

    const requiredBlocks = Object.keys(txHashesByBlockNumber)
      .map(Number)
      .sort((a, b) => a - b);

    // If toBlock is not already required, add it. This is necessary
    // to mark the full block range of the eth_getLogs request as cached.
    if (!requiredBlocks.includes(toBlock)) {
      requiredBlocks.push(toBlock);
    }

    const requiredIntervals: {
      startBlock: number;
      endBlock: number;
      logs: RpcLog[];
      transactionHashes: Set<Hash>;
    }[] = [];

    let prev = fromBlock;
    for (const blockNumber of requiredBlocks) {
      requiredIntervals.push({
        startBlock: prev,
        endBlock: blockNumber,
        logs: logsByBlockNumber[blockNumber] ?? [],
        transactionHashes: txHashesByBlockNumber[blockNumber] ?? new Set(),
      });
      prev = blockNumber + 1;
    }

    return requiredIntervals;
  };

  private enqueueBlockTasks = () => {
    // If a source has an endBlock and is completed, its checkpoint
    // will be equal to its endBlock. This poses a problem if other sources
    // don't have an endBlock and are still in progress, because this value
    // will get "stuck" at the endBlock. To avoid this, filter out any sources
    // that have no more required intervals.
    const blockTasksCanBeEnqueuedTo = Math.min(
      ...[
        ...Object.values(this.logFilterProgressTrackers),
        ...Object.values(this.factoryChildAddressProgressTrackers),
        ...Object.values(this.factoryLogFilterProgressTrackers),
        ...Object.values(this.blockFilterProgressTrackers),
        ...Object.values(this.traceFilterProgressTrackers),
      ]
        .filter((i) => i.getRequired().length > 0)
        .map((i) => i.getCheckpoint()),
    );

    if (blockTasksCanBeEnqueuedTo > this.blockTasksEnqueuedCheckpoint) {
      const newBlocks = Object.keys(this.blockCallbacks)
        .map(Number)
        .filter((blockNumber) => blockNumber <= blockTasksCanBeEnqueuedTo);

      this.blockProgressTracker.addPendingBlocks({ blockNumbers: newBlocks });

      for (const blockNumber of newBlocks) {
        this.queue.addTask(
          {
            kind: "BLOCK",
            blockNumber,
            callbacks: this.blockCallbacks[blockNumber],
          },
          { priority: Number.MAX_SAFE_INTEGER - blockNumber },
        );
        delete this.blockCallbacks[blockNumber];
      }

      this.common.logger.trace({
        service: "historical",
        msg: `Enqueued ${newBlocks.length} BLOCK tasks [${
          this.blockTasksEnqueuedCheckpoint + 1
        }, ${blockTasksCanBeEnqueuedTo}] (network=${this.network.name})`,
      });

      this.blockTasksEnqueuedCheckpoint = blockTasksCanBeEnqueuedTo;
    }
  };

  /**
   * Helper function for "eth_getLogs" rpc request.
   * Handles different error types and retries the request if applicable.
   */
  private _eth_getLogs = (params: {
    address?: Address | Address[];
    topics?: LogTopic[];
    fromBlock: Hex;
    toBlock: Hex;
  }): Promise<RpcLog[]> => {
    return this.requestQueue.request({
      method: "eth_getLogs",
      params: [
        {
          fromBlock: params.fromBlock,
          toBlock: params.toBlock,

          topics: params.topics,
          address: params.address
            ? Array.isArray(params.address)
              ? params.address.map((a) => toLowerCase(a))
              : toLowerCase(params.address)
            : undefined,
        },
      ],
    });
  };

  /**
   * Helper function for "eth_getBlockByNumber" request.
   */
  private _eth_getBlockByNumber = (params: {
    blockNumber: number;
  }): Promise<HistoricalBlock> =>
    this.requestQueue
      .request({
        method: "eth_getBlockByNumber",
        params: [numberToHex(params.blockNumber), true],
      })
      .then((block) => {
        if (!block)
          throw new BlockNotFoundError({
            blockNumber: BigInt(params.blockNumber),
          });
        return block as HistoricalBlock;
      });

  /**
   * Helper function for "eth_getTransactionReceipt" request.
   */
  private _eth_getTransactionReceipt = ({
    hash,
  }: {
    hash: Hex;
  }): Promise<RpcTransactionReceipt> =>
    this.requestQueue
      .request({
        method: "eth_getTransactionReceipt",
        params: [hash],
      })
      .then((receipt) => {
        if (!receipt)
          throw new TransactionReceiptNotFoundError({
            hash,
          });
        return receipt as RpcTransactionReceipt;
      });

  /**
   * Helper function for "insertLogFilterInterval"
   */
  private _insertLogFilterInterval = ({
    logInterval: { logs, startBlock, endBlock },
    logFilter,
    block,
    transactions,
    transactionReceipts,
    chainId,
  }: {
    logInterval: LogInterval;
    logFilter: LogFilterCriteria;
    block: HistoricalBlock;
    transactions: HistoricalTransaction[];
    transactionReceipts: RpcTransactionReceipt[];
    chainId: number;
  }) =>
    this.syncStore.insertLogFilterInterval({
      chainId,
      logFilter,
      block,
      transactions,
      transactionReceipts,
      logs,
      interval: {
        startBlock: BigInt(startBlock),
        endBlock: BigInt(endBlock),
      },
    });

  private debouncedEmitCheckpoint = debounce(
    HISTORICAL_CHECKPOINT_EMIT_INTERVAL,
    (checkpoint: Checkpoint) => {
      this.emit("historicalCheckpoint", checkpoint);
    },
  );
}
