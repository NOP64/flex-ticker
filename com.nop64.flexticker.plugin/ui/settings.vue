<template>
  <v-container class="pt-8">
    <div class="text-h6 mb-2">Flex Ticker API keys</div>
    <p class="mb-4">
      Keys are stored in your computer's secure store ({{ storeName }}), never in a file. They take effect right away.
    </p>

    <v-alert v-if="error" type="error" density="compact" variant="tonal" class="mb-4">{{ error }}</v-alert>

    <v-card v-for="k in fields" :key="k.which" variant="tonal" class="mb-4 pa-4">
      <div class="text-subtitle-1">{{ k.title }}</div>
      <p class="mb-2">{{ k.help }}</p>
      <v-chip :color="status[k.which] && status[k.which] !== 'none' ? 'success' : 'orange'" size="small" class="mb-3">
        {{ status[k.which] && status[k.which] !== 'none' ? 'Stored in ' + status[k.which] : 'Not set' }}
      </v-chip>
      <v-text-field
        v-model="entry[k.which]"
        type="password"
        autocomplete="off"
        density="compact"
        variant="outlined"
        :label="k.which === 'finnhub' ? 'Finnhub API key' : 'Massive API key'"
        hide-details
        class="mb-3"
      />
      <v-btn color="primary" :disabled="busy || !entry[k.which]" @click="save(k.which)">Save</v-btn>
      <v-btn class="ml-2" :disabled="busy || !(status[k.which] && status[k.which] !== 'none')" @click="remove(k.which)">
        Remove
      </v-btn>
    </v-card>

    <p v-if="feed" class="text-caption">Quote feed: {{ feed }}</p>
  </v-container>
</template>

<script>
// Talks to the backend (src/plugin.js, "ui.message"). The backend never sends a key back, only where one is stored.
export default {
  data() {
    return {
      fields: [
        { which: 'finnhub', title: 'Finnhub (required)', help: 'Live quotes. Free key at finnhub.io.' },
        { which: 'massive', title: 'Massive (optional)', help: 'History, charts beyond today, logos and indices. Free key at massive.com.' },
      ],
      entry: { finnhub: '', massive: '' },
      status: {},
      feed: '',
      error: '',
      busy: false,
    }
  },
  computed: {
    storeName() {
      return 'Keychain, Credential Manager or Secret Service, depending on your system'
    },
  },
  methods: {
    apply(r) {
      if (r && r.error) {
        this.error = r.error
        return
      }
      this.error = ''
      this.status = { finnhub: r.finnhub, massive: r.massive }
      this.feed = r.feed
    },
    async call(msg) {
      this.busy = true
      try {
        this.apply(await this.$fd.sendToBackend(msg))
      } catch (e) {
        this.error = 'The plugin did not answer. Is it running?'
      }
      this.busy = false
    },
    async save(which) {
      await this.call({ type: 'saveKey', which, value: this.entry[which] })
      if (!this.error) this.entry[which] = ''
    },
    remove(which) {
      return this.call({ type: 'deleteKey', which })
    },
  },
  mounted() {
    return this.call({ type: 'keyStatus' })
  },
}
</script>
