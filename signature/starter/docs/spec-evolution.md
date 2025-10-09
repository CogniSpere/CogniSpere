# Schema Evolution Notes

## Signature Components – Design Rationale

- `authenticity` was split from `trace` to reduce ambiguity.
- `confidence` now uses a range and score for human-AI reconciliation.
- Planned addition: `ethics` module for better accountability and downstream use.

## Future Considerations
- Time decay / trust aging model
- Revocation and supersession of signature statements
