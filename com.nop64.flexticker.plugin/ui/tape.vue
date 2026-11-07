<template>
  <v-container class="pt-8">
    <div class="text-subtitle-1 mb-2">{{ $t('Tape.UI.Title') }}</div>
    <p class="mb-2">{{ $t('Tape.UI.File') }}</p>
    <div>macOS: <code>~/Library/Application Support/flex-ticker/settings.json</code></div>
    <div>Windows: <code>%APPDATA%&#92;flex-ticker&#92;settings.json</code></div>
    <div>Linux: <code>~/.config/flex-ticker/settings.json</code></div>
    <p class="mt-4">{{ $t('Tape.UI.Live') }}</p>
    <p class="mt-2">{{ $t('Tape.UI.Menu') }}</p>
    <p class="mt-2">{{ $t('Tape.UI.Style') }}</p>
  </v-container>
</template>

<script>
// Settings live in a JSON file watched by the backend (src/settings.js), not in key data.
export default {
  props: {
    modelValue: {
      type: Object,
      required: true,
    },
  },
  emits: ['update:modelValue'],
};
</script>

<style scoped></style>
