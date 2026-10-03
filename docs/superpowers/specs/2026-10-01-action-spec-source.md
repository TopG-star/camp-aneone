# Oneon Action Spec: source document

**Author:** product owner · **Given:** 2026-09-27 · **Recorded:** 2026-10-01

This is the product owner's original Action Spec, the input to
[`2026-10-01-action-spec-framework-design.md`](2026-10-01-action-spec-framework-design.md).
It was given as free text in a working session, so its line breaks were lost in transit.
Headings, lists, tables and code blocks have been restored; the wording is unchanged. The one box
diagram in §14 is condensed to a vertical flow with the same content.

---

Yes. The current Oneon build sounds like it has execution plumbing, but not an action specification.

What I would add is a formal Oneon Action Spec that sits between intent/reasoning and execution:

```text
User intent → Oneon decides an action → Action Spec validates it → approval policy → executor → verification → audit/rollback
```

The important distinction is that an action should not simply be "create_po" plus some arbitrary
payload. It needs a typed contract describing what Oneon is allowed to do, what it changes, what
evidence supports it, what risk it carries, who can approve it, and how it can be reversed.

## 1. The core Action Spec

I'd make every action conform conceptually to something like:

```ts
interface OneonActionSpec {
  type: ActionType;
  version: string;
  intent: {
    goal: string;
    reason: string;
  };
  target: {
    entityType: EntityType;
    entityId?: string;
    locationId?: string;
  };
  input: Record<string, unknown>;
  effects: {
    reads: Resource[];
    writes: Resource[];
    creates?: EntityType[];
    modifies?: EntityType[];
  };
  risk: {
    level: ActionRiskLevel;
    financialImpact?: MoneyRange;
    operationalImpact?: string;
    reversible: boolean;
  };
  authorization: {
    requiredPermissions: Permission[];
    allowedRoles: Role[];
    requiresApproval: boolean;
    approvalPolicy?: ApprovalPolicy;
  };
  evidence: Evidence[];
  execution: {
    executor: string;
    idempotencyKey: string;
    timeout?: number;
  };
  rollback?: {
    supported: boolean;
    actionType?: ActionType;
    payload?: Record<string, unknown>;
  };
  verification: {
    checks: VerificationCheck[];
  };
  audit: {
    actor: "user" | "oneon";
    source: string;
    correlationId: string;
  };
}
```

The LLM should produce an intent, not be trusted to invent all of this structure.

Oneon should resolve:

```text
Intent
  ↓
Action Registry
  ↓
Typed Action Spec
  ↓
Policy Engine
  ↓
Approval
  ↓
Executor
```

That is much safer.

## 2. I'd create an Action Registry

This is probably the biggest missing piece in your current build.

Something like:

```text
Action Registry
SALES
├── CREATE_SALES_ORDER
├── UPDATE_SALES_ORDER
├── CANCEL_SALES_ORDER
├── CREATE_QUOTE
├── APPLY_DISCOUNT
└── REFUND_SALE
INVENTORY
├── CREATE_STOCK_TRANSFER
├── APPROVE_STOCK_TRANSFER
├── ADJUST_INVENTORY
├── RESERVE_STOCK
├── RELEASE_STOCK
├── WRITE_OFF_STOCK
└── CHANGE_REORDER_POINT
PURCHASING
├── CREATE_PURCHASE_ORDER
├── UPDATE_PURCHASE_ORDER
├── SUBMIT_PURCHASE_ORDER
├── APPROVE_PURCHASE_ORDER
├── CANCEL_PURCHASE_ORDER
└── CREATE_SUPPLIER_ORDER
CUSTOMERS
├── CREATE_CUSTOMER
├── UPDATE_CUSTOMER
├── UPDATE_CREDIT_LIMIT
├── CREATE_PAYMENT_REMINDER
└── RECORD_PAYMENT
PRODUCTS
├── CREATE_PRODUCT
├── UPDATE_PRODUCT
├── UPDATE_PRICE
├── UPDATE_PRODUCT_STATUS
└── ARCHIVE_PRODUCT
SUPPLIERS
├── CREATE_SUPPLIER
├── UPDATE_SUPPLIER
├── UPDATE_SUPPLIER_PRICE
└── UPDATE_SUPPLIER_TERMS
REPORTING
├── GENERATE_REPORT
├── EXPORT_REPORT
└── SCHEDULE_REPORT
COMMUNICATION
├── SEND_CUSTOMER_MESSAGE
├── SEND_SUPPLIER_MESSAGE
├── SEND_INTERNAL_NOTIFICATION
└── CREATE_TASK
AUTOMATION
├── CREATE_WATCH
├── CREATE_ALERT_RULE
├── CREATE_SCHEDULED_REPORT
├── CREATE_WORKFLOW
└── PAUSE_AUTOMATION
```

But I'd go further.

## 3. Actions should be business actions, not database actions

This is extremely important.

Don't expose:

```text
UPDATE_INVENTORY_ROW
UPDATE_CUSTOMER_FIELD
INSERT_PURCHASE_ORDER
```

Expose:

```text
ADJUST_INVENTORY
CREATE_PURCHASE_ORDER
UPDATE_CUSTOMER_CREDIT_LIMIT
```

Because Oneon is reasoning about business intent.

For example:

> "Move 50 units of Tavanic from Tema warehouse to Accra branch."

should resolve to `CREATE_STOCK_TRANSFER`, not:

```text
UPDATE_STOCK_QUANTITY
UPDATE_LOCATION_ID
INSERT_TRANSFER_RECORD
```

The ERP owns those underlying mutations.

## 4. The action types I'd define for Impresso

I'd structure them around the ERP domains.

**Sales**

| Action | Typical risk |
|---|---|
| Create sales order | L1 |
| Update sales order | L1 |
| Cancel sales order | L2 |
| Create quote | L1 |
| Apply discount | L2/L3 |
| Refund sale | L3 |
| Create invoice | L2 |
| Send invoice | L2 |

**Inventory**

| Action | Typical risk |
|---|---|
| Create stock transfer | L2 |
| Approve stock transfer | L2 |
| Adjust inventory | L3 |
| Reserve inventory | L2 |
| Release inventory | L1 |
| Write off inventory | L3 |
| Change reorder point | L2 |
| Change safety stock | L2 |

**Purchasing**

| Action | Typical risk |
|---|---|
| Draft PO | L1 |
| Create PO | L2 |
| Submit PO | L2 |
| Approve PO | L3 |
| Cancel PO | L2 |
| Create supplier order | L2 |

**Customers / credit**

| Action | Typical risk |
|---|---|
| Create customer | L1 |
| Update customer | L1 |
| Create payment reminder | L1/L2 |
| Send payment reminder | L2 |
| Change credit limit | L3 |
| Apply customer credit | L3 |
| Record payment | L3 |

**Products**

| Action | Typical risk |
|---|---|
| Create product | L1 |
| Update product | L1/L2 |
| Change selling price | L3 |
| Change product status | L2 |
| Archive product | L3 |

**Suppliers**

| Action | Typical risk |
|---|---|
| Create supplier | L1 |
| Update supplier | L1 |
| Update supplier price | L2 |
| Change supplier terms | L3 |

**Communication**

| Action | Typical risk |
|---|---|
| Create internal task | L1 |
| Send internal notification | L1 |
| Draft customer message | L1 |
| Send customer message | L2 |
| Send supplier message | L2 |

**Intelligence / reporting**

These are mostly safe:

```text
GENERATE_REPORT
EXPORT_REPORT
CREATE_DASHBOARD_VIEW
SCHEDULE_REPORT
CREATE_WATCH
CREATE_ALERT_RULE
```

## 5. Then create the risk model

I'd keep your existing:

```text
L0 Read
L1 Low-risk
L2 Business action
L3 Consequential
L4 Restricted
```

But make it action-spec metadata, not just a label. For example:

```text
CREATE_STOCK_TRANSFER = {
  risk: "L2",
  reversible: true,
  approval: {
    requiredAbove: {
      quantity: 100
    }
  }
}
```

While:

```text
WRITE_OFF_INVENTORY = {
  risk: "L3",
  reversible: false,
  requiresApproval: true
}
```

And:

```text
CHANGE_USER_PERMISSION = {
  risk: "L4",
  requiresApproval: true,
  allowedRoles: ["OWNER", "ADMIN"]
}
```

## 6. Crucially: action specs should be configuration-aware

This is where your Business Profile architecture becomes important.

Oneon shouldn't have `CREATE_STOCK_TRANSFER` and assume every business behaves identically.
Instead:

```text
Action
  ↓
Business Profile
  ↓
Capabilities
  ↓
Policies
  ↓
Allowed parameters
```

For example:

**Pharmacy**

```text
CREATE_STOCK_TRANSFER
Requires:
- source location
- destination location
- product
- quantity
Additional:
- batch
- expiry
- FEFO validation
- cold-chain requirements
```

**Fashion**

```text
CREATE_STOCK_TRANSFER
Requires:
- source location
- destination location
- product
- quantity
Additional:
- size
- colour
- variant
```

Same action. Different business configuration. That's exactly the architecture you want.

## 7. Actions should have preconditions

Before executing `CREATE_PURCHASE_ORDER`, Oneon should run deterministic checks. Example:

```text
Preconditions
✓ Supplier exists
✓ Supplier is active
✓ Products exist
✓ Products are purchasable
✓ Quantities > 0
✓ Prices are valid
✓ Currency matches
✓ Location exists
✓ User has purchasing permission
✓ Business has purchasing capability
```

For a pharma configuration:

```text
✓ Batch rules
✓ Regulatory restrictions
✓ Cold-chain constraints
✓ Restricted-product permissions
```

The LLM should never be responsible for these checks.

## 8. Add postconditions

This is the piece many agent systems miss.

Don't stop at "Executed successfully". Define what success means.

For `CREATE_PURCHASE_ORDER`, postconditions might be:

```text
PO exists
PO status = DRAFT
Supplier = X
Total = GH₵X
Line count = 8
```

For `CREATE_STOCK_TRANSFER`, verify:

```text
Transfer exists
Source = Tema
Destination = Accra
Quantity = 50
Status = PENDING
```

For `SEND_PAYMENT_REMINDER`, verify:

```text
message accepted by provider
recipient = customer contact
message ID exists
```

Then:

```text
Action → Execute → Verify → Completed / Failed / PartiallyCompleted
```

## 9. Make rollback a first-class capability

Your current build already has rollback payloads/routes, which is good, but I'd formalize it.

Not every action should be rollbackable.

**Naturally reversible:** `CREATE_DRAFT_PO`, `CREATE_TASK`, `CREATE_WATCH`, `CREATE_STOCK_TRANSFER`, `RESERVE_STOCK`

**Conditionally reversible:** `UPDATE_PRICE`, `UPDATE_CREDIT_LIMIT`, `UPDATE_PRODUCT`. You can store the previous state.

**Not truly reversible:** `SEND_EMAIL`, `SEND_PAYMENT`, `RECORD_EXTERNAL_PAYMENT`, `WRITE_OFF`, `DELETE`

For those, the system should explicitly say:

> This action cannot be automatically reversed.

Don't pretend that a compensating action is the same thing as rollback.

## 10. Your action lifecycle should become richer

Instead of only Proposed, Approved, Executed, Rejected, RolledBack, I'd use:

```text
PROPOSED
  ↓
VALIDATING
  ↓
AWAITING_APPROVAL
  ↓
APPROVED
  ↓
EXECUTING
  ↓
VERIFYING
  ↓
COMPLETED
```

With side states: `REJECTED`, `EXPIRED`, `FAILED`, `PARTIALLY_COMPLETED`, `ROLLED_BACK`,
`ROLLBACK_FAILED`, `CANCELLED`.

This becomes incredibly useful when Oneon eventually performs multi-step workflows.

## 11. Then introduce Action Plans

This is where Oneon becomes an agent, rather than an AI chatbot.

Suppose the user says:

> "We're going to run out of these three products next week. Sort it out."

Oneon shouldn't generate one giant action. It creates a plan:

```text
PLAN-1042
1. Analyze demand
2. Check current stock
3. Check outstanding purchase orders
4. Check supplier availability
5. Calculate recommended quantities
6. Draft purchase order
7. Present PO for approval
8. Send supplier order
9. Monitor delivery
```

Each step has its own Action Spec.

```text
ActionPlan
├── Analysis
├── Recommendation
├── Draft PO
├── Approval
├── Submit PO
└── Monitor
```

That's much closer to the ERP Oneon you described.

## 12. I'd also create "spec actions" versus "runtime actions"

This is an important distinction for your architecture.

**Action Definition.** Static registry, e.g. `CREATE_PURCHASE_ORDER`. Defines: schema, permissions,
risk, preconditions, postconditions, executor, rollback behavior, approval policy.

**Action Instance.** Actual execution:

```text
action_8f923
type: CREATE_PURCHASE_ORDER
tenant: bernova
actor: oneon
target: supplier_183
payload: {...}
evidence: [...]
status: AWAITING_APPROVAL
```

So:

```text
ActionDefinition
  ↓
ActionInstance
  ↓
Execution
  ↓
Verification
```

That separation will save you a lot of pain later.

## 13. And I'd add an Evidence Spec

Every consequential Oneon action should be explainable. For example:

> I recommend ordering 120 units of Product X.

Evidence:

```text
Current stock: 34
Average weekly sales: 52
Projected 14-day demand: 104
Open PO: 0
Supplier lead time: 7 days
Safety stock: 25
Recommended order: 120
```

Then the action `CREATE_PURCHASE_ORDER` references those evidence objects. So you get:

```text
Signal
  ↓
Evidence
  ↓
Recommendation
  ↓
Action
  ↓
Approval
  ↓
Execution
  ↓
Verification
```

That is much stronger than: LLM says "buy 120".

## 14. The Oneon architecture I'd now build

Given your current implementation, I'd move toward this:

```text
User / Event
  ↓
Intent Resolver
  ↓
Decision Engine
  ↓
ACTION REGISTRY
  action type · schema · permissions · risk · preconditions
  approval policy · executor · rollback · verification
  ↓
Policy Engine
  ↓
Approval / Authority
  ↓
Action Executor
  ↓
Verification
  ↓
Audit + Action Memory
```

And sitting across all of this: Business Profile, Permissions, Capabilities, Policies, Tenant
Context, Location Scope.

## The biggest change I'd make to your current build

Right now, from what you've described, you have things like: simulated mode, rollback payload,
rollback route, `executor_not_configured`.

Those are implementation details of action execution. You're missing the layer above them:

```text
WHAT CAN ONEON DO?
WHAT DOES THAT ACTION MEAN?
WHO CAN AUTHORIZE IT?
WHAT CONDITIONS MUST BE TRUE?
WHAT DOES IT CHANGE?
WHAT EVIDENCE JUSTIFIED IT?
CAN IT BE REVERSED?
HOW DO WE KNOW IT ACTUALLY WORKED?
```

I'd therefore make Action Specifications a foundational Oneon domain, alongside Intent, Signal,
Evidence, Policy, Approval and Execution.

The conceptual model I'd use is:

```text
ONEON Context
  ↓
Intent
  ↓
Signal / Evidence
  ↓
Decision
  ↓
Action Specification
  ↓
Policy
  ↓
Approval
  ↓
Action Instance
  ↓
Execution
  ↓
Verification
  ↓
Outcome
  ↓
Memory
```

And importantly, Oneon should never be allowed to invent an action type. The LLM can request
`CREATE_PURCHASE_ORDER`; the Action Registry determines whether that action exists, what its schema
is, what permissions it requires, and how it is safely executed.

That gives you a foundation on which the future autonomous workflows, automations, business rules,
and vertical-specific behavior can all sit without turning Oneon into an uncontrolled LLM connected
directly to your ERP.

---

## Addendum: guiding principle (design review, 2026-10-01)

> **LLM proposes. Code defines. Database configures. Policy authorizes. Executor changes the world.
> Event log remembers.**

```text
CODE / TYPES                 action schemas · executors · validators ·
                             verification logic · rollback handlers
  ↓
ACTION DEFINITIONS (DB)      enabled/disabled · risk · permissions ·
                             approval rules · tenant overrides · thresholds
  ↓
ACTION INSTANCE (DB)         what Oneon actually proposed/executed
  ↓
ACTION EVENTS (DB)           proposed · approved · executing · completed ·
                             failed · rolled_back
```
