import { Effect } from "effect";
import {
  Backoff,
  Workflow,
  createDurableWorkflows,
} from "@durable-effect/workflow";

// =============================================================================
// Example Effects (simulated async operations)
// =============================================================================

const randomDelay = () =>
  Effect.promise(() => {
    const ms = 2000 + Math.random() * 2000; // 2-4 seconds
    return new Promise((resolve) => setTimeout(resolve, ms));
  });

const fetchOrder = (orderId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Fetching order ${orderId}...`);

    yield* randomDelay();
    return {
      id: orderId,
      amount: 99.99,
      email: "customer@example.com",
      items: ["item1", "item2"],
    };
  });

const processPayment = (order: { id: string; amount: number }) =>
  Effect.gen(function* () {
    yield* Effect.log(
      `Processing payment for order ${order.id}: $${order.amount}`,
    );
    yield* randomDelay();

    // 70% chance of failure
    if (Math.random() < 0.6) {
      yield* Effect.fail(new Error("Payment processing failed"));
    }

    return {
      transactionId: `txn_${Date.now()}`,
      amount: order.amount,
      status: "completed" as const,
    };
  });

const sendConfirmation = (email: string, orderId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Sending confirmation to ${email} for order ${orderId}`);
    yield* randomDelay();
    return { sent: true };
  });

const generateReport = (reportId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Generating report ${reportId}...`);
    yield* randomDelay();
    return {
      id: reportId,
      sections: ["summary", "details", "charts"],
      pages: Math.floor(Math.random() * 20) + 5,
    };
  });

const analyzeData = (data: { id: string; sections: string[] }) =>
  Effect.gen(function* () {
    yield* Effect.log(`Analyzing data for report ${data.id}...`);
    yield* randomDelay();

    // 30% chance of failure
    if (Math.random() < 0.3) {
      yield* Effect.fail(new Error("Data analysis failed - invalid format"));
    }

    return {
      insights: data.sections.length * 3,
      anomalies: Math.floor(Math.random() * 5),
      score: Math.random() * 100,
    };
  });

const exportToPdf = (reportId: string, analysis: { insights: number; score: number }) =>
  Effect.gen(function* () {
    yield* Effect.log(`Exporting report ${reportId} to PDF...`);
    yield* randomDelay();
    return {
      filename: `report-${reportId}.pdf`,
      size: `${Math.floor(Math.random() * 500) + 100}KB`,
      insights: analysis.insights,
    };
  });

const notifyStakeholders = (reportId: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Notifying stakeholders about report ${reportId}...`);
    yield* randomDelay();
    return {
      notified: ["manager@example.com", "analyst@example.com"],
      timestamp: new Date().toISOString(),
    };
  });

// =============================================================================
// Workflow Definitions
// =============================================================================
const processOrderWorkflow = Workflow.make((orderId: string) =>
  Effect.gen(function* () {
    const order = yield* Workflow.step("Fetch order", fetchOrder(orderId));
    yield* Workflow.sleep("3 seconds");
    yield* Workflow.step(
      {
        name: "Process data",
        retries: {
          maxAttempts: 3,
          delay: Backoff.exponential({
            max: "6 seconds",
            base: "1 second",
          }),
        },
        timeout: "10 seconds",
        execute: function* () {
          yield* Effect.log(`Processing order data: ${order.id}`);
          return { processed: true };
        },
      }
     ),
    );
    yield* Workflow.sleep("1 seconds");

    const payment = yield* Workflow.step(
      "Process payment",
      processPayment(order).pipe(
        Workflow.retry({
          maxAttempts: 3,
          delay: Backoff.exponential({
            max: "6 seconds",
            base: "1 second",
          }),
        }),
      ),
    );

    yield* Workflow.step(
      "Send confirmation",
      sendConfirmation(order.email, order.id),
    );
    yield* Workflow.sleep("1 seconds");

    return { order, payment };
  }),
);

const generateReportWorkflow = Workflow.make((reportId: string) =>
  Effect.gen(function* () {
    // Step 1: Generate initial report structure
    const report = yield* Workflow.step("Generate report", generateReport(reportId));
    yield* Workflow.sleep("2 seconds");

    // Step 2: Validate report structure
    yield* Workflow.step(
      "Validate structure",
      Effect.gen(function* () {
        yield* Effect.log(`Validating report structure: ${report.sections.length} sections`);
        return { valid: true, sections: report.sections.length };
      }),
    );
    yield* Workflow.sleep("1 seconds");

    // Step 3: Analyze data with retry
    const analysis = yield* Workflow.step(
      "Analyze data",
      analyzeData(report).pipe(
        Workflow.retry({
          maxAttempts: 4,
          delay: Backoff.exponential({
            max: "8 seconds",
            base: "500 millis",
          }),
        }),
      ),
    );
    yield* Workflow.sleep("2 seconds");

    // Step 4: Export to PDF
    const pdf = yield* Workflow.step("Export to PDF", exportToPdf(report.id, analysis));
    yield* Workflow.sleep("1 seconds");

    // Step 5: Notify stakeholders
    const notification = yield* Workflow.step(
      "Notify stakeholders",
      notifyStakeholders(report.id),
    );

    return {
      report,
      analysis,
      pdf,
      notification,
    };
  }),
);

// =============================================================================
// Export Durable Object Class and Client
// =============================================================================

const workflows = {
  processOrder: processOrderWorkflow,
  generateReport: generateReportWorkflow,
} as const;

export const { Workflows, WorkflowClient } = createDurableWorkflows(workflows, {
  tracker: {
    env: "production",
    serviceKey: "finance-workflows",
    endpoint: "https://tanstack-trpc-on-cloudflare.backpine.workers.dev/sync",
    batchSize: 2,

    retry: {
      maxAttempts: 2,
    },
  },
});
export type WorkflowsType = typeof Workflows;
