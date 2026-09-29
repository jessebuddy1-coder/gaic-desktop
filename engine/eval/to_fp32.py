import onnx, numpy as np, sys
from onnx import numpy_helper, TensorProto
m = onnx.load(sys.argv[1]); g = m.graph
F16, F32 = TensorProto.FLOAT16, TensorProto.FLOAT
for i, t in enumerate(g.initializer):
    if t.data_type == F16:
        a = numpy_helper.to_array(t).astype(np.float32)
        g.initializer[i].CopyFrom(numpy_helper.from_array(a, t.name))
for n in g.node:
    for a in n.attribute:
        if n.op_type == "Cast" and a.name == "to" and a.i == F16: a.i = F32
        if a.type == onnx.AttributeProto.TENSOR and a.t.data_type == F16:
            a.t.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(a.t).astype(np.float32), a.t.name))
        if n.op_type == "ConstantOfShape" and a.name == "value" and a.t.data_type == F16:
            a.t.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(a.t).astype(np.float32)))
for vi in list(g.value_info) + list(g.input) + list(g.output):
    if vi.type.tensor_type.elem_type == F16: vi.type.tensor_type.elem_type = F32
onnx.save(m, sys.argv[2]); print("ok")
