# Re-embedding contract (v1)

The host's migration path after the embedding role changes, reached as
`MemoryKernel.reEmbed(projectId)` and implemented by
`src/embedding/ReEmbeddingPipeline.ts`. It is held to this document by
`__tests__/re-embedding.contract.test.ts`.

## Migration set

The pipeline migrates **every non-deleted, non-empty neuron in the project that
has no `neuron_embeddings` row for the current model**, plus any embedding row
whose neuron no longer exists. A neuron with a row for a different model is not
current either: it is migrated and its old rows are removed after the new
vector is written.

This makes a brain that never had vectors — `neurons` N, `neuron_embeddings`
0 — migratable. Before v1 the set was read from `neuron_embeddings` alone, so
such a brain always reported `processed: 0`.

## Properties

- **Idempotent.** A second run with no work returns
  `{ processed: 0, remaining: 0 }` and leaves the embedding rows unchanged.
- **Batched with a cursor.** Progress is the
  `re_embedding_progress(projectId, modelId, lastProcessedNeuronId)` row,
  written after each batch. A budget stop resumes from that cursor.
- **Cursor lifecycle.** The progress row is deleted when the project has no
  work left. A failed batch leaves the cursor and the un-migrated rows in
  place so the next run retries them.
- **Fail closed on dimension mismatch.** A vector that does not match the
  provider's `dimensions` throws and leaves the neuron for retry; it is never
  stored.

## What it does not do

- It does not schedule itself; the host decides when to run it.
- It does not embed queries, delete neurons or change the neuron's content.
- It does not touch another project's cursor or rows.
