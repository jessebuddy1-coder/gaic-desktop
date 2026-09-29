"""Add a 'features' output with forensic-friendly summaries of the residual
stream: for the final LayerNorm output and the LayerNorm inputs of blocks 9
and 6, the CLS token and the mean of the 196 patch tokens (6 x 384 = 2304).
The existing 'logit' output and all weights are untouched."""
import onnx, sys, numpy as np
from onnx import helper, TensorProto, numpy_helper
src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src); g = m.graph
# drop any earlier 'features' output/cast from add_output.py
outs = [o for o in g.output if o.name != "features"]
del g.output[:]; g.output.extend(outs)
keep = [n for n in g.node if not (n.op_type == "Cast" and "features" in n.output)]
del g.node[:]; g.node.extend(keep)
taps = ["/vit/norm/LayerNormalization_output_0",
        "/vit/blocks/blocks.9/norm1/LayerNormalization_output_0",
        "/vit/blocks/blocks.6/norm1/LayerNormalization_output_0"]
produced = {o for n in g.node for o in n.output}
for t in taps: assert t in produced, t
g.initializer.extend([
    numpy_helper.from_array(np.array(0, dtype=np.int64), "rich_idx0"),
    numpy_helper.from_array(np.array([1], dtype=np.int64), "rich_s1"),
    numpy_helper.from_array(np.array([197], dtype=np.int64), "rich_e197"),
    numpy_helper.from_array(np.array([1], dtype=np.int64), "rich_ax1"),
])
parts = []
for i, t in enumerate(taps):
    c = f"rich_cls{i}"; s = f"rich_sl{i}"; pm = f"rich_pm{i}"; f32 = f"rich_f32_{i}"
    # widen to float32 first: fp16 reductions are not available on every backend
    g.node.append(helper.make_node("Cast", [t], [f32], to=TensorProto.FLOAT, name=f"rich_widen{i}"))
    g.node.append(helper.make_node("Gather", [f32, "rich_idx0"], [c], axis=1, name=f"rich_gather{i}"))
    g.node.append(helper.make_node("Slice", [f32, "rich_s1", "rich_e197", "rich_ax1"], [s], name=f"rich_slice{i}"))
    g.node.append(helper.make_node("ReduceMean", [s], [pm], axes=[1], keepdims=0, name=f"rich_mean{i}"))
    parts += [c, pm]
g.node.append(helper.make_node("Concat", parts, ["features"], axis=1, name="rich_concat"))
g.output.append(helper.make_tensor_value_info("features", TensorProto.FLOAT, ["batch", 2304]))
onnx.checker.check_model(m)
onnx.save(m, dst); print("saved", dst)
