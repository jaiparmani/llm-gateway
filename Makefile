VENV := .venv/bin

.PHONY: install proto test serve docker
install:
	python3 -m venv .venv && $(VENV)/pip install -e ".[dev]"

proto:
	$(VENV)/python -m grpc_tools.protoc -I proto --python_out=gateway/gen --grpc_python_out=gateway/gen proto/llm.proto
	sed -i '' 's/^import llm_pb2 as llm__pb2$$/from . import llm_pb2 as llm__pb2/' gateway/gen/llm_pb2_grpc.py

test:
	$(VENV)/python -m pytest -q

serve:
	$(VENV)/python -m gateway serve

docker:
	docker compose up --build
