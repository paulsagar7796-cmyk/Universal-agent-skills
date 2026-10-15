# Training debugging checklist

Work top to bottom; change one thing at a time and record each attempt as an experiment (even failed ones).

## Loss is NaN or explodes

1. Check inputs: NaN/inf in features or labels, division by zero in normalisation, log of zero.
2. Lower the learning rate (×0.1); add gradient clipping; check the warm-up schedule.
3. Mixed precision: try fp32 to see if overflow is the cause; check loss scaling.
4. Custom losses: verify numerically on a tiny batch with known answers.

## Loss does not decrease

1. Overfit a single small batch (e.g. 8–32 examples). If it cannot, the bug is in the model/loss/data pipeline, not
   in the hyperparameters.
2. Check labels line up with inputs (shuffled separately?), the loss matches the output (logits vs probabilities),
   the optimiser receives the right parameters, gradients are not zero (`requires_grad`, frozen layers).
3. Learning rate too small or too large: run a short LR sweep.

## Overfitting

Validation stops improving while training keeps improving. Options: more data or augmentation, regularisation
(weight decay, dropout), smaller model, early stopping on validation — and report which was used.

## Results look too good

Assume leakage until shown otherwise: duplicates between train and test, preprocessing fitted on all data, target or
future information in features, test set used for model selection. Run the `data-analysis` leakage check.

## Out of memory

Reduce batch size (and use gradient accumulation to keep the effective batch), use mixed precision, gradient
checkpointing, shorter sequences; check for tensors kept alive across iterations (e.g. accumulating loss without
`.item()`/`.detach()`).

## Non-determinism

Set all seeds, enable deterministic algorithms where available, fix data loader worker seeds, record library and
CUDA versions. Some GPU kernels remain non-deterministic: that is why results are reported over several seeds.
