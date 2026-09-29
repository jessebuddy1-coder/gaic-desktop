#!/bin/bash
# featqueue2.sh THREADS name1 list1 [name2 list2 ...]
cd "$(dirname "$0")"
T=$1; shift
while (( $# >= 2 )); do
  FEAT_THREADS=$T node feat_harness.mjs runtime featmodel/rich32.onnx "$2" ../data/rfeat/$1.jsonl 1 > ../data/rfeat/$1.log 2>&1
  shift 2
done
