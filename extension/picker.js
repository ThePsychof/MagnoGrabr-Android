(function (root) {
  "use strict";

  let nextId = 0;

  function createPicker(container, { label, options, value, onChange }) {
    const id = `mg-picker-${nextId++}`;
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "picker-trigger";
    trigger.setAttribute("aria-label", label);
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", `${id}-list`);

    const text = document.createElement("span");
    text.className = "picker-value";
    const arrow = document.createElement("span");
    arrow.className = "picker-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "▾";
    trigger.append(text, arrow);

    const list = document.createElement("div");
    list.id = `${id}-list`;
    list.className = "picker-menu";
    list.setAttribute("role", "menu");
    list.setAttribute("aria-label", label);
    list.hidden = true;

    const entries = options.map(([optionValue, optionLabel]) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "picker-option";
      option.setAttribute("role", "menuitemradio");
      option.dataset.value = optionValue;
      option.textContent = optionLabel;
      option.addEventListener("click", () => {
        setValue(optionValue);
        close(false);
        onChange?.(optionValue);
        trigger.focus();
      });
      list.append(option);
      return option;
    });

    function setValue(nextValue) {
      const selected = options.find(([optionValue]) => optionValue === nextValue) || options[0];
      if (!selected) return;
      value = selected[0];
      text.textContent = selected[1];
      trigger.title = selected[1];
      for (const option of entries) {
        option.setAttribute("aria-checked", String(option.dataset.value === value));
      }
    }

    function close(returnFocus) {
      list.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      if (returnFocus) trigger.focus();
    }

    function open(focusOption) {
      if (trigger.disabled) return;
      list.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      if (focusOption) {
        const selected = entries.find((option) => option.dataset.value === value);
        (selected || entries[0])?.focus();
      }
    }

    trigger.addEventListener("click", () => {
      if (list.hidden) open(false);
      else close(false);
    });
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        open(true);
      } else if (event.key === "Escape" && !list.hidden) {
        event.preventDefault();
        close(false);
      }
    });
    list.addEventListener("keydown", (event) => {
      const current = entries.indexOf(document.activeElement);
      let next = null;
      if (event.key === "ArrowDown") next = (current + 1) % entries.length;
      else if (event.key === "ArrowUp") next = (current - 1 + entries.length) % entries.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = entries.length - 1;
      else if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      } else if (event.key === "Tab") {
        close(false);
        return;
      }
      if (next !== null && entries[next]) {
        event.preventDefault();
        entries[next].focus();
      }
    });
    document.addEventListener("click", (event) => {
      if (!container.contains(event.target)) close(false);
    });

    container.classList.add("picker");
    container.replaceChildren(trigger, list);
    setValue(value);
    return {
      get value() { return value; },
      setValue,
      setDisabled(disabled) { trigger.disabled = disabled; }
    };
  }

  root.MagnoGrabrPicker = { createPicker };
})(globalThis);
