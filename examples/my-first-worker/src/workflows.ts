import { Effect } from 'effect';
import { Workflow, createDurableWorkflows } from '@durable-effect/workflow';

// =============================================================================
// Example Effects (simulated async operations)
// =============================================================================

const fetchOrder = (orderId: string) =>
	Effect.gen(function* () {
		yield* Effect.log(`Fetching order ${orderId}...`);
		yield* Effect.sleep('100 millis');
		return {
			id: orderId,
			amount: 99.99,
			email: 'customer@example.com',
			items: ['item1', 'item2'],
		};
	});

const processPayment = (order: { id: string; amount: number }) =>
	Effect.gen(function* () {
		yield* Effect.log(`Processing payment for order ${order.id}: $${order.amount}`);
		yield* Effect.sleep('200 millis');

		// Simulate occasional failure
		if (Math.random() < 0.3) {
			return yield* Effect.fail(new Error('Payment gateway temporarily unavailable'));
		}

		return {
			transactionId: `txn_${Date.now()}`,
			amount: order.amount,
			status: 'completed' as const,
		};
	});

const sendConfirmation = (email: string, orderId: string) =>
	Effect.gen(function* () {
		yield* Effect.log(`Sending confirmation to ${email} for order ${orderId}`);
		yield* Effect.sleep('100 millis');
		return { sent: true };
	});

// =============================================================================
// Workflow Definitions
// =============================================================================

/**
 * Order processing workflow demonstrating:
 * - Simple cached steps
 * - Steps with durable retry
 * - Steps with timeout
 * - Workflow context access
 */
const processOrderWorkflow = Workflow.make('processOrder', (orderId: string) =>
	Effect.gen(function* () {
		yield* Effect.log('=== Starting Order Processing Workflow ===');

		// Access workflow context
		const ctx = yield* Workflow.Context;
		yield* ctx.setMeta('startedAt', Date.now());

		// Step 1: Fetch order (cached)
		const order = yield* Workflow.step('Fetch order', fetchOrder(orderId));

		// Step 2: Process payment with retry
		const payment = yield* Workflow.step(
			'Process payment',
			processPayment(order).pipe(Workflow.retry({ maxAttempts: 3, delay: '2 seconds' })),
		);

		// Step 3: Send confirmation with timeout
		yield* Workflow.step('Send confirmation', sendConfirmation(order.email, order.id).pipe(Workflow.timeout('30 seconds')));

		// Store completion metadata
		yield* ctx.setMeta('completedAt', Date.now());
		yield* ctx.setMeta('transactionId', payment.transactionId);

		yield* Effect.log(`=== Order ${orderId} completed! ===`);
	}),
);

/**
 * Simple greeting workflow for testing
 */
const greetWorkflow = Workflow.make('greet', (input: { name: string }) =>
	Effect.gen(function* () {
		yield* Effect.log(`=== Starting Greet Workflow ===`);

		const greeting = yield* Workflow.step('Generate greeting', Effect.succeed(`Hello, ${input.name}!`));

		yield* Effect.log(greeting);
		yield* Effect.log(`=== Greet Workflow Complete ===`);
	}),
);

/**
 * Scheduled workflow with durable sleep
 */
const scheduledWorkflow = Workflow.make('scheduled', (taskId: string) =>
	Effect.gen(function* () {
		yield* Effect.log('=== Starting Scheduled Workflow ===');

		yield* Workflow.step('Initial task', Effect.log(`Processing task ${taskId}`));

		// Durable sleep - survives restarts
		yield* Workflow.sleep('10 seconds');

		yield* Workflow.step('Follow-up task', Effect.log(`Follow-up for task ${taskId}`));

		yield* Effect.log('=== Scheduled Workflow Complete ===');
	}),
);

// =============================================================================
// Export Durable Object Class
// =============================================================================

const workflows = {
	processOrder: processOrderWorkflow,
	greet: greetWorkflow,
	scheduled: scheduledWorkflow,
} as const;

export const OrderWorkflows = createDurableWorkflows(workflows);

// Export types for use in index.ts
export type OrderWorkflowsType = InstanceType<typeof OrderWorkflows>;

export interface ServiceBindings extends Env {
	ORDER_WORKFLOWS: DurableObjectNamespace<InstanceType<typeof OrderWorkflows>>;
}
