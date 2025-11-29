export { OrderWorkflows } from './workflows';
import { ServiceBindings } from './workflows';

export default {
	async fetch(request: Request, env: ServiceBindings): Promise<Response> {
		const url = new URL(request.url);

		// POST /workflows/processOrder?orderId=xxx
		if (request.method === 'GET' && url.pathname === '/workflows/processOrder') {
			const orderId = url.searchParams.get('orderId') ?? `order-${Date.now()}`;

			const id = env.ORDER_WORKFLOWS.idFromName(orderId);
			const stub = env.ORDER_WORKFLOWS.get(id);

			const result = await stub.run({
				workflow: 'processOrder',
				input: orderId,
			});

			return Response.json({
				success: true,
				workflowId: result.id,
				orderId,
			});
		}

		// POST /workflows/greet?name=xxx
		if (request.method === 'POST' && url.pathname === '/workflows/greet') {
			const name = url.searchParams.get('name') ?? 'World';

			const id = env.ORDER_WORKFLOWS.idFromName(`greet-${name}`);
			const stub = env.ORDER_WORKFLOWS.get(id);

			const result = await stub.run({
				workflow: 'greet',
				input: { name },
			});

			return Response.json({
				success: true,
				workflowId: result.id,
			});
		}

		// POST /workflows/scheduled?taskId=xxx
		if (request.method === 'POST' && url.pathname === '/workflows/scheduled') {
			const taskId = url.searchParams.get('taskId') ?? `task-${Date.now()}`;

			const id = env.ORDER_WORKFLOWS.idFromName(taskId);
			const stub = env.ORDER_WORKFLOWS.get(id);

			const result = await stub.run({
				workflow: 'scheduled',
				input: taskId,
			});

			return Response.json({
				success: true,
				workflowId: result.id,
				taskId,
			});
		}

		// GET /workflows/:id/status
		if (request.method === 'GET' && url.pathname.startsWith('/workflows/') && url.pathname.endsWith('/status')) {
			const parts = url.pathname.split('/');
			const instanceId = parts[2];

			const id = env.ORDER_WORKFLOWS.idFromName(instanceId);
			const stub = env.ORDER_WORKFLOWS.get(id);

			const status = await stub.getStatus();
			const completedSteps = await stub.getCompletedSteps();

			return Response.json({
				instanceId,
				status,
				completedSteps,
			});
		}

		// Default response
		return Response.json({
			message: 'Durable Effect Workflow Example',
			endpoints: {
				'POST /workflows/processOrder?orderId=xxx': 'Start order processing workflow',
				'POST /workflows/greet?name=xxx': 'Start greeting workflow',
				'POST /workflows/scheduled?taskId=xxx': 'Start scheduled workflow',
				'GET /workflows/:id/status': 'Get workflow status',
			},
		});
	},
} satisfies ExportedHandler<ServiceBindings>;
