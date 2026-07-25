"use client";

import { Plus, Trash2 } from "lucide-react";
import type { TodoEntry } from "@/shared/types";

type TodoListEditorProps = {
  value: TodoEntry[];
  onChange: (value: TodoEntry[]) => void;
};

export function TodoListEditor({ value, onChange }: TodoListEditorProps) {
  function updateTodo(id: string, patch: Partial<TodoEntry>) {
    onChange(value.map((todo) => (todo.id === id ? { ...todo, ...patch } : todo)));
  }

  function removeTodo(id: string) {
    onChange(value.filter((todo) => todo.id !== id));
  }

  function addTodo() {
    onChange([...value, { id: createTodoId(), text: "", done: false }]);
  }

  return (
    <div className="todo-editor">
      <span className="field-title">Things to do</span>
      <div className="todo-editor-list">
        {value.map((todo, index) => (
          <div className="todo-editor-row" key={todo.id}>
            <input
              type="checkbox"
              checked={todo.done}
              onChange={(event) => updateTodo(todo.id, { done: event.target.checked })}
              aria-label={`Mark task ${index + 1} done`}
            />
            <input
              value={todo.text}
              onChange={(event) => updateTodo(todo.id, { text: event.target.value })}
              placeholder={`Task ${index + 1}`}
            />
            <button className="icon-button" type="button" onClick={() => removeTodo(todo.id)} aria-label={`Remove task ${index + 1}`}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <button className="secondary-button add-todo-button" type="button" onClick={addTodo}>
        <Plus size={14} />
        Add task
      </button>
    </div>
  );
}

export function createTodoId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `todo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
