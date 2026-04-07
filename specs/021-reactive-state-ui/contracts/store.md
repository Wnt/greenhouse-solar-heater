# Contract: Reactive State Store

**Module**: `playground/js/store.js`

## API

### `createStore(initialState) → Store`

Creates a new reactive store with the given initial state shape.

**Parameters**:
- `initialState: object` — flat key-value pairs defining the initial state

**Returns**: Store instance with the methods below.

### `store.get(key) → value`

Returns the current value for the given key.

### `store.set(key, value) → void`

Sets a single key. If the new value is strictly equal (`===`) to the current value, no notification fires. Otherwise, all subscribers for that key are called synchronously.

### `store.update(partial) → void`

Sets multiple keys atomically. Collects all changed keys, then notifies each key's subscribers once after all mutations are applied. Prevents intermediate render states.

**Parameters**:
- `partial: object` — key-value pairs to update

### `store.subscribe(key, callback) → unsubscribe`

Registers a callback to be called whenever the given key changes.

**Parameters**:
- `key: string` — the state key to observe
- `callback: (value, fullState) → void` — called synchronously on change

**Returns**: `() → void` — call to remove the subscription.

### `store.subscribeAll(callback) → unsubscribe`

Registers a callback called on any state change.

**Parameters**:
- `callback: (changedKey, fullState) → void`

**Returns**: `() → void`

### `store.snapshot() → object`

Returns a shallow copy of the current state. Safe to read without triggering subscriptions.

## Guarantees

1. **Synchronous notification**: Subscribers are called immediately within the `set()`/`update()` call, not deferred to a microtask or macrotask.
2. **No spurious notifications**: If `set()` is called with the same value (by `===`), no subscriber is notified.
3. **Atomic batch**: Within `update()`, no subscriber fires until all keys are mutated. Each changed key's subscribers fire once.
4. **Subscription cleanup**: The returned `unsubscribe` function removes the callback. No dangling references.
5. **No nested notification guard**: If a subscriber calls `set()` during notification, the inner notification fires immediately (re-entrant). This is intentional — state consistency is maintained because each `set()` is synchronous and complete before returning.

## Non-Guarantees

- No deep equality checking. Object/array values are compared by reference only.
- No middleware, action logging, or time-travel debugging.
- No persistence — the store is ephemeral (page-scoped).
