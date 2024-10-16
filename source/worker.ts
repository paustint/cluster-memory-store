// /source/worker.ts
// A `memory` store for the `express-rate-limit` middleware that stores hits in the primary process

import cluster from 'node:cluster'
import process from 'node:process'
import type {
	Store,
	Options as RateLimitConfiguration,
	IncrementResponse,
} from 'express-rate-limit'
import createDebug from 'debug'
import type { Options } from './types'
import {
	type Command,
	type PrimaryToWorkerMessage,
	type WorkerToPrimaryMessage,
	from,
	type SerializedIncrementResponse,
} from './shared.js'

const debug = createDebug(
	`cluster-memory-store:${
		cluster.isWorker
			? `worker:${cluster.worker?.id}`
			: `not-a-worker:${process.pid}`
	}`,
)

const errorPrefix = `ClusterMemoryStoreWorker:${
	cluster.worker?.id ?? 'not-a-worker'
}:`

/**
 * A `Store` for the `express-rate-limit` package that communicates with the primary process to store and retrieve hits
 */
export class ClusterMemoryStoreWorker implements Store {
	/**
	 * The number of seconds to remember a client's requests.
	 */
	windowMs!: number

	/**
	 * Optional Unique Identifier
	 */
	prefix!: string

	/**
	 * Map of requestId to the data & calllback needed to finish handling a request without throwingany errors
	 */
	private readonly openRequests = new Map<
		number,
		{ timeoutId: NodeJS.Timeout; resolve: (value: unknown) => void }
	>()

	/**
	 * Counter to generate reqiestIds, which are used to tie the response to the matching openRequest
	 */
	private currentRequestId = 0

	/**
	 * @constructor for `ClusterMemoryStore`.
	 *
	 * @param options {Options} - The options used to configure the store's behaviour.
	 */
	constructor(options?: Partial<Options>) {
		debug('Creating with options %o', options)
		this.prefix = options?.prefix ?? 'default'
		if (!cluster.isWorker) {
			console.warn(
				new Error(errorPrefix + ' instance created in non-worker process'),
			)
		}
	}

	/**
	 * Method that actually initializes the store.
	 *
	 * @param options {RateLimitConfiguration} - The options used to setup the middleware.
	 *
	 * @impl
	 */
	async init(options: RateLimitConfiguration) {
		debug('Initializing with parent options %o', options)
		this.windowMs = options.windowMs
		if (!cluster.worker) {
			throw new Error(
				`${errorPrefix} cluster.worker is undefined, unable to initialize`,
			)
		}

		cluster.worker.on('message', this.onMessage.bind(this))
		return this.send('init', [{ windowMs: this.windowMs }], 10 * 1000).catch(
			(error: any) => {
				console.error(`${errorPrefix} failed to initialize`, error)
			},
		)
	}

	/**
	 * Method to increment a client's hit counter.
	 *
	 * @param key {string} - The identifier for a client.
	 *
	 * @returns {IncrementResponse} - The number of hits and reset time for that client.
	 */
	async increment(key: string): Promise<IncrementResponse> {
		const { totalHits, resetTime } = (await this.send('increment', [
			key,
		])) as SerializedIncrementResponse
		return {
			totalHits,
			resetTime: new Date(resetTime), // Date objects are serialized to strings for IPC
		}
	}

	/**
	 * Method to decrement a client's hit counter.
	 *
	 * @param key {string} - The identifier for a client
	 */
	async decrement(key: string): Promise<void> {
		await this.send('decrement', [key])
	}

	/**
	 * Method to reset a client's hit counter.
	 *
	 * @param key {string} - The identifier for a client.
	 */
	async resetKey(key: string): Promise<void> {
		await this.send('resetKey', [key])
	}

	private async send(
		command: Command,
		args: any[],
		timelimit = 1000,
	): Promise<any> {
		debug('Sending command %s with args %o', command, args)
		return new Promise((resolve, reject) => {
			const requestId = this.currentRequestId++
			const timeoutId = setTimeout(() => {
				reject(
					new Error(
						`${errorPrefix} no response recieved to ${command} command after ${timelimit}ms.`,
					),
				)
				this.openRequests.delete(requestId)
			}, timelimit)
			this.openRequests.set(requestId, { timeoutId, resolve })
			if (!process.send) {
				reject(
					new Error(
						`${errorPrefix} process.send is undefined, indicating that this is probably not a node:cluster worker.`,
					),
				)
				return
			}

			const message: WorkerToPrimaryMessage = {
				command,
				args,
				requestId,
				prefix: this.prefix,
				from,
			}

			const shouldSendMore = process.send(
				message,
				undefined,
				undefined,
				(error: any) => {
					if (error) {
						clearTimeout(timeoutId)
						this.openRequests.delete(requestId)
						reject(error)
					}
				},
			)
			if (!shouldSendMore) {
				console.warn(
					new Error(
						errorPrefix +
							'  process.send() returned false indicating that the channel is closed and/or there is a large backlog of messages waiting to be sent.',
					),
				)
			}
		})
	}

	private onMessage(message: any) {
		debug('Recieved message %o', message)
		if (message?.from === from && message?.prefix === this.prefix) {
			const message_ = message as PrimaryToWorkerMessage
			if (this.openRequests.has(message_.requestId)) {
				const { timeoutId, resolve } = this.openRequests.get(
					message_.requestId,
				)!
				this.openRequests.delete(message_.requestId)
				clearTimeout(timeoutId)
				resolve(message_.result)
			} else {
				console.warn(
					new Error(
						`${errorPrefix} response recieved without matching open request: ` +
							JSON.stringify(message_),
					),
				)
			}
		}
		// Else it's not our message
	}
}
