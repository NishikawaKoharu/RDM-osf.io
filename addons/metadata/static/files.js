'use strict';

const $ = require('jquery');
const m = require('mithril');
const Fangorn = require('js/fangorn').Fangorn;
const Raven = require('raven-js');
const $osf = require('js/osfHelpers');

const logPrefix = '[metadata] ';
const rdmGettext = require('js/rdmGettext');
const _ = rdmGettext._;

const ImportDatasetButton = require('./metadataImportDatasetButton.js');

const QuestionPage = require('./metadata-fields.js').QuestionPage;
const WaterButlerCache = require('./wbcache.js').WaterButlerCache;
const registrations = require('./registration.js');
const RegistrationSchemas = registrations.RegistrationSchemas;
const DraftRegistrations = registrations.DraftRegistrations;
const Registrations = registrations.Registrations;


const osfBlock = {
  originBaseZ: $.blockUI.defaults.baseZ,
  // modal z-index is 1050
  baseZ: 1100,
  block: function() {
    $.blockUI.defaults.baseZ = this.baseZ;
    $osf.block();
  },
  unblock: function() {
    $osf.unblock();
    $.blockUI.defaults.baseZ = this.originBaseZ;
  }
};

const METADATA_CACHE_EXPIRATION_MSEC = 1000 * 60 * 5;
var tempIdCounterForDataset = 1000;

function MetadataButtons() {
  var self = this;
  self.baseUrl = contextVars.node.urls.api + 'metadata/';
  self.loading = null;
  self.contexts = null;
  self.loadingMetadatas = {};
  self.currentItem = null;
  self.registrationSchemas = new RegistrationSchemas();
  self.draftRegistrations = new DraftRegistrations();
  self.registeringFilepath = null;
  self.selectDraftDialog = null;
  self.reservedRows = [];
  self.moveCompleteHandlers = [];

  self.loadConfig = function(callback) {
    if (self.loading !== null) {
      return;
    }
    self.loading = true;
    const loadedCallback = function() {
      self.loading = false;
      const path = self.processHash();
      m.redraw();
      if (!callback) {
        return;
      }
      callback(path);
    };
    self.registrationSchemas.load(function() {
      self.loadMetadata(contextVars.node.id, contextVars.node.urls.api + 'metadata/', function() {
        loadedCallback();
      });
    });
  };

  self.addMoveCompleteHandler = function(handler) {
    self.moveCompleteHandlers.push(handler);
  };

  self.processHash = function() {
    const path = self.getContextPath();
    if (!path) {
      return null;
    }
    if (window.location.hash !== '#edit-metadata') {
      return path;
    }
    const context = self.findContextByNodeId(contextVars.node.id);
    if (!context) {
      return null;
    }
    self.editMetadata(context, path, self.getFileItemFromContext());
    return path;
  }

  self.getContextPath = function() {
    if (contextVars.file && contextVars.file.provider) {
      return contextVars.file.provider + contextVars.file.materializedPath;
    }
    const projectMetadata = self.findProjectMetadataByNodeId(contextVars.node.id);
    if (!projectMetadata) {
      return null;
    }
    const currentMetadata = (projectMetadata.files || []).filter(function(f) {
      return f.urlpath === window.location.pathname;
    })[0];
    if (!currentMetadata) {
      return null;
    }
    return currentMetadata.path;
  }

  self.loadMetadata = function(nodeId, baseUrl, callback) {
    if (self.loadingMetadatas[nodeId]) {
      return;
    }
    if (!baseUrl) {
      throw new Error('baseUrl is not defined');
    }
    self.loadingMetadatas[nodeId] = true;
    const url = baseUrl + 'project';
    console.log(logPrefix, 'loading: ', url);

    return $.ajax({
        url: url,
        type: 'GET',
        dataType: 'json'
    }).done(function (data) {
      self.loadingMetadatas[nodeId] = false;
      console.log(logPrefix, 'loaded: ', data);
      if (!self.contexts) {
        self.contexts = {};
      }
      const metadata = {
        nodeId: nodeId,
        baseUrl: baseUrl,
        projectMetadata: (data.data || {}).attributes,
        wbcache: (self.contexts[nodeId] ? self.contexts[nodeId].wbcache : null) || new WaterButlerCache(),
        validatedFiles: (self.contexts[nodeId] ? self.contexts[nodeId].validatedFiles : null) || {},
        addonAttached: true,
        repositories: null
      };
      self.loadRepositories(
        metadata.projectMetadata.repositories || [],
        function(repositories) {
          self.loadingMetadatas[nodeId] = false;
          metadata.repositories = repositories;
          const files = [];
          (metadata.projectMetadata.files || []).forEach(function(file) {
            files.push(file);
          });
          metadata.repositories.forEach(function(repo, repoIndex) {
            if (!repo.data || repo.data.type !== 'metadata-node-files') {
              return;
            }
            (repo.data.attributes || []).forEach(function(file) {
              const readonly = !metadata.projectMetadata.repositories[repoIndex].metadata.urls.update;
              files.push(Object.assign(file, {
                readonly: readonly,
              }));
            });
          });
          metadata.projectMetadata.files = files;
          console.log(logPrefix, 'Metadata loaded', metadata);
          self.contexts[nodeId] = metadata;
          if (!callback) {
            return;
          }
          callback((data.data || {}).attributes);
        }
      );
    }).fail(function(xhr, status, error) {
      self.loadingMetadatas[nodeId] = false;
      if (xhr.status === 400) {
        if (!self.contexts) {
          self.contexts = {};
        }
        self.contexts[nodeId] = {
          nodeId: nodeId,
          baseUrl: baseUrl,
          projectMetadata: {
            editable: false,
            files: []
          },
          wbcache: (self.contexts[nodeId] ? self.contexts[nodeId].wbcache : null) || new WaterButlerCache(),
          validatedFiles: (self.contexts[nodeId] ? self.contexts[nodeId].validatedFiles : null) || {},
          addonAttached: false
        };
      } else {
        $osf.growl('Error', 'Error while retrieving addon info for "' + nodeId + '": ' + xhr.status);
        Raven.captureMessage('Error while retrieving addon info', {
          extra: {
              url: url,
              status: status,
              error: error
          }
        });
      }
      if (!callback) {
        return;
      }
      callback(null);
    });
  };

  self.lastQuestionPage = null;

  // For Metadata-supported addon
  self.loadRepositories = function(repos, callback) {
    if (repos.length === 0) {
      callback([]);
      return;
    }
    self.loadRepository(repos[0], function(result) {
      self.loadRepositories(repos.slice(1), function(results) {
        results.splice(0, 0, result);
        callback(results);
      });
    });
  };

  self.loadRepository = function(repo, callback) {
    if (!repo.metadata) {
      if (!callback) {
        return;
      }
      callback(null);
      return;
    }
    const url = repo.metadata.urls.get;
    console.log(logPrefix, 'loading: ', repo, url);
    return $.ajax({
        url: url,
        type: 'GET',
        dataType: 'json'
    }).done(function (data) {
      console.log(logPrefix, 'loaded: ', data);
      if (!callback) {
        return;
      }
      callback(data);
    }).fail(function(xhr, status, error) {
      Raven.captureMessage('Error while retrieving addon info', {
        extra: {
            url: url,
            status: status,
            error: error
        }
      });
      if (!callback) {
        return;
      }
      callback(null);
    });
  };

  self.lastMetadata = null;
  self.lastFields = null;
  self.currentSchemaId = null;

  self.createQuestionPage = function(schema, item, options) {
    const questionPage = new QuestionPage(schema, item, options);
    questionPage.create();
    return questionPage;
  };

  self.createProjectMetadataQuestionPage = function(schema, item, options) {
    const questionPage = new QuestionPage(schema, { data: item }, options);
    questionPage.setQuestionFilter(function(question) {
      return question.qid && !question.qid.match(/^grdm-file:.+/);
    });
    questionPage.create();
    return questionPage;
  };

  self.prepareFields = function(context, container, schema, filepath, fileitem, options) {
    var lastMetadataItem = {};
    if (!options.multiple) {
      lastMetadataItem = (self.lastMetadata.items || []).filter(function(item) {
        const resolved = self.resolveActiveSchemaId(item.schema) || self.currentSchemaId;
        return resolved === schema.id;
      })[0] || {};
    }
    self.lastQuestionPage = self.createQuestionPage(
      schema.attributes.schema,
      lastMetadataItem,
      {
        readonly: !((context.projectMetadata || {}).editable) || lastMetadataItem.readonly,
        multiple: options.multiple,
        context: context,
        filepath: filepath,
        wbcache: context.wbcache,
        fileitem: fileitem
      }
    );
    self.lastFields = self.lastQuestionPage.fields;
    container.empty();
    self.lastFields.forEach(function(field) {
      container.append(field.element);
    });
    self.lastQuestionPage.validateAll();
  }

  self.findSchemaById = function(schemaId) {
    const targetSchemas = self.registrationSchemas.schemas.filter(function(s) {
      return s.id == schemaId;
    });
    if (targetSchemas.length == 0) {
      return null;
    }
    return targetSchemas[0];
  }

  self.resolveActiveSchemaId = function(schemaId) {
    const targetSchemas = (self.registrationSchemas.schemas || [])
      .filter(function(s) {
        return s.id === schemaId;
      });
    if (targetSchemas.length === 0) {
      console.warn(logPrefix, 'No schemas for ' + schemaId);
      return null;
    }
    const targetSchema = targetSchemas[0];
    if (targetSchema.attributes.active) {
      return targetSchema.id;
    }
    const alternativeSchemas = (self.registrationSchemas.schemas || [])
      .filter(function(s) {
        return s.attributes.name === targetSchema.attributes.name;
      });
    if (alternativeSchemas.length === 0) {
      console.warn(logPrefix, 'No schemas for ' + targetSchema.attributes.name);
      return null;
    }
    return alternativeSchemas[0].id;
  }

  self.createSchemaSelector = function(targetItem) {
    const label = $('<label></label>').text(_('Metadata Schema:'));
    const schema = $('<select></select>');
    const activeSchemas = (self.registrationSchemas.schemas || [])
      .filter(function(s) {
        return s.attributes.active;
      });
    if (activeSchemas.length === 0) {
      throw new Error('No active metadata schemas');
    }
    activeSchemas.forEach(function(s) {
      schema.append($('<option></option>')
        .attr('value', s.id)
        .text(s.attributes.name));
    });
    var currentSchemaId = null;
    const activeSchemaIds = activeSchemas.map(function(s) {
      return s.id;
    });
    if (targetItem.schema && activeSchemaIds.includes(targetItem.schema)) {
      currentSchemaId = targetItem.schema;
      schema.val(currentSchemaId);
    } else if (targetItem.schema && self.resolveActiveSchemaId(targetItem.schema)) {
      currentSchemaId = self.resolveActiveSchemaId(targetItem.schema);
      schema.val(currentSchemaId);
    } else {
      currentSchemaId = activeSchemas[0].id;
      schema.val(currentSchemaId);
    }
    const group = $('<div></div>').addClass('form-group')
      .append(label)
      .append(schema);
    return {
      schema: schema,
      group: group,
      currentSchemaId: currentSchemaId,
    }
  }

  self.findProjectMetadataByNodeId = function(nodeId) {
    const ctx = self.findContextByNodeId(nodeId);
    if (!ctx) {
      return null;
    }
    return ctx.projectMetadata;
  };

  self.findContextByNodeId = function(nodeId) {
    if (!self.contexts) {
      return null;
    }
    return self.contexts[nodeId];
  };

  self.findMetadataByPath = function(nodeId, filepath) {
    const projectMetadata = self.findProjectMetadataByNodeId(nodeId);
    if (!projectMetadata) {
      return null;
    }
    const currentMetadatas = projectMetadata.files.filter(function(f) {
      return f.path === filepath;
    });
    if (currentMetadatas.length === 0) {
      return null;
    }
    return currentMetadatas[0];
  };

  /**
   * Get the file item for input fields.
   */
  self.getFileItemFromContext = function() {
    if (contextVars.directory) {
      const dir = contextVars.directory;
      return {
        kind: 'folder',
        data: {
          materialized: dir.materializedPath,
          path: dir.path,
          provider: dir.provider,
          nodeId: contextVars.node.id
        }
      };
    }
    if (contextVars.file) {
      const file = contextVars.file;
      return {
        kind: 'file',
        data: {
          name: file.name,
          materialized: file.materializedPath,
          path: file.path,
          provider: file.provider,
          nodeId: contextVars.node.id,
          extra: file.extra,
        }
      };
    }
    return null;
  }

  /**
   * Extra metadata entity for a file item
   */
  self._getExtraMetadataEntity = function(item) {
    return (((item || {}).data || {}).extra || {}).metadata;
  }

  /**
   * Extra read-only metadata for a file item
   */
  self.getExtraMetadata = function(item) {
    return (self._getExtraMetadataEntity(item) || {}).content;
  }

  /**
   * Whether metadata is editable for a file item
   */
  self.isMetadataEditable = function(item) {
    const entity = self._getExtraMetadataEntity(item);
    if (!entity) {
      return true;
    }
    return entity.can_edit;
  }

  /**
   * Whether metadata is registerable for a file item
   */
  self.isMetadataRegisterable = function(item) {
    const entity = self._getExtraMetadataEntity(item);
    if (!entity) {
      return true;
    }
    return entity.can_register;
  }

  /**
   * Start editing metadata.
   */
  self.editMetadata = function(context, filepath, item) {
    var dialog = null;
    const extraMetadata = self.getExtraMetadata(item);
    if ((context.projectMetadata || {}).editable && !extraMetadata) {
      if (!self.editMetadataDialog) {
        self.editMetadataDialog = self.initEditMetadataDialog(true);
      }
      dialog = self.editMetadataDialog;
    } else {
      if (!self.viewMetadataDialog) {
        self.viewMetadataDialog = self.initEditMetadataDialog(false);
      }
      dialog = self.viewMetadataDialog;
    }
    console.log(logPrefix, 'edit(or view) metadata: ', filepath, item, extraMetadata);
    self.currentItem = item;
    const currentMetadata = extraMetadata || self.findMetadataByPath(context.nodeId, filepath);
    if (!currentMetadata) {
      self.lastMetadata = {
        path: filepath,
        folder: item.kind === 'folder',
        items: [],
      };
    } else {
      self.lastMetadata = Object.assign({}, currentMetadata);
    }
    self.editingContext = context;
    dialog.toolbar.empty();
    dialog.container.empty();
    dialog.copyStatus.text('');
    const fieldContainer = $('<div></div>');
    const activeItems = (self.lastMetadata.items || []).filter(function(item_) {
      return item_.active;
    });
    const targetItem = activeItems[0] || {};
    const selector = self.createSchemaSelector(targetItem);
    self.currentSchemaId = selector.currentSchemaId;
    selector.schema.change(function(event) {
      if (event.target.value == self.currentSchemaId) {
        return;
      }
      self.currentSchemaId = event.target.value;
      self.prepareFields(
        context,
        fieldContainer,
        self.findSchemaById(self.currentSchemaId),
        filepath,
        item,
        {}
      );
    });
    dialog.toolbar.append(selector.group);
    if ((context.projectMetadata || {}).editable && !extraMetadata) {
      const pasteButton = $('<button></button>')
        .addClass('btn btn-default')
        .css('margin-right', 0)
        .css('margin-left', 'auto')
        .append($('<i></i>').addClass('fa fa-paste'))
        .append(_('Paste from Clipboard'))
        .attr('type', 'button')
        .on('click', self.pasteFromClipboard);
      dialog.toolbar.append($('<div></div>')
        .css('display', 'flex')
        .append(pasteButton));
    }
    if (dialog.customHandler) {
      dialog.customHandler.empty();
      if (item.data && item.data.provider && contextVars.metadataHandlers && contextVars.metadataHandlers[item.data.provider]) {
        const customButton = contextVars.metadataHandlers[item.data.provider];
        const button = $('<a href="#" class="btn btn-success"></a>')
          .text(customButton.text)
          .css('margin-left', '5px');
        button.click(function() {
          osfBlock.block();
          self.saveEditMetadataModal()
            .finally(function() {
              osfBlock.unblock();
              $(dialog.dialog).modal('hide');
              const activeItems = (self.lastMetadata.items || []).filter(function(item_) {
                return item_.active;
              });
              customButton.click(item, self.currentSchemaId, activeItems[0] || null);
            })
        });
        dialog.customHandler.append(button);
      }
    }
    self.prepareFields(
      context,
      fieldContainer,
      self.findSchemaById(self.currentSchemaId),
      filepath,
      item,
      {}
    );
    dialog.container.append(fieldContainer);
    dialog.dialog.modal('show');
  };


  /**
   * Start editing multiple metadata.
   */
  self.editMultipleMetadata = function(context, filepaths, items) {
    if (!self.editMultipleMetadataDialog) {
      self.editMultipleMetadataDialog = self.initEditMultipleMetadataDialog();
    }
    const dialog = self.editMultipleMetadataDialog;
    console.log(logPrefix, 'edit multiple metadata: ', filepaths, items);
    self.currentItem = items;
    self.lastMetadata = {
      path: filepaths,
      items: [],
    };
    self.editingContext = context;

    // toolbar
    const currentMetadatas = filepaths.map(function(filepath) {
      return self.findMetadataByPath(context.nodeId, filepath);
    }).filter(Boolean);
    const targetItems = currentMetadatas.map(function(currentMedatata) {
      return (currentMedatata.items || []).filter(function(item) {
        return item.active;
      })[0] || null;
    });
    const targetItem = targetItems.filter(Boolean)[0] || {};
    const selector = self.createSchemaSelector(targetItem);
    self.currentSchemaId = selector.currentSchemaId;
    selector.schema.change(function(event) {
      if (event.target.value === self.currentSchemaId) {
        return;
      }
      self.currentSchemaId = event.target.value;
      self.prepareFields(
        context,
        fieldContainer,
        self.findSchemaById(self.currentSchemaId),
        filepaths,
        items,
        {multiple: true}
      );
    });
    dialog.toolbar.empty();
    dialog.toolbar.append(selector.group);

    // container
    dialog.container.empty();
    const fieldContainer = $('<div></div>');
    self.prepareFields(
      context,
      fieldContainer,
      self.findSchemaById(self.currentSchemaId),
      filepaths,
      items,
      {multiple: true}
    );
    dialog.container.append(fieldContainer);

    dialog.dialog.modal('show');
  };

  /**
   * Convert the field data to JSON and copy it to the clipboard.
   */
  self.copyToClipboard = function(event, copyStatus) {
    event.preventDefault();
    console.log(logPrefix, 'copy to clipboard');
    copyStatus.text('');
    if (!navigator.clipboard) {
      $osf.growl('Error', _('Could not copy text'));
      Raven.captureMessage(_('Could not copy text'), {
        extra: {
          error: 'navigator.clipboard API is not supported.',
        },
      });
    }
    var jsonObject = {};
    (self.lastFields || []).forEach(function(field) {
      jsonObject[field.question.qid] = field.getValue();
    });
    const text = JSON.stringify(jsonObject);
    navigator.clipboard.writeText(text).then(function() {
      copyStatus.text(_('Copied!'));
    }, function(err) {
      $osf.growl('Error', _('Could not copy text'));
      Raven.captureMessage(_('Could not copy text'), {
        extra: {
          error: err.toString(),
        },
      });
    });
  };

  /**
   * Paste a string from the clipboard and set it in the field.
   */
  self.pasteFromClipboard = function(event) {
    event.preventDefault();
    console.log(logPrefix, 'paste from clipboard');
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      if (!self.pasteMetadataDialog) {
        self.pasteMetadataDialog = self.initPasteMetadataDialog();
      }
      self.pasteMetadataDialog.modal('show');
      return;
    }
    navigator.clipboard.readText().then(function(text) {
      self.setMetadataFromJson(text);
    }, function(err) {
      $osf.growl('Error', _('Could not paste text'));
      Raven.captureMessage(_('Could not paste text'), {
        extra: {
          error: err.toString(),
        },
      });
    });
  };

  self.setMetadataFromJson = function(jsonText) {
    try {
      const jsonObject = JSON.parse(jsonText);
      (self.lastFields || []).forEach(function(field) {
        field.setValue(jsonObject[field.question.qid] || '');
      });
      if (self.lastQuestionPage) {
        self.lastQuestionPage.validateAll();
      }
    } catch(err) {
      console.error(logPrefix, 'Could not paste text', err);
      $osf.growl('Error', _('Could not paste text'));
      Raven.captureMessage(_('Could not paste text'), {
        extra: {
          error: err.toString(),
        },
      });
    }
  }

  self.registerMetadata = function(context, filepath, item) {
    self.registeringFilepath = filepath;
    self.registeringContext = context;
    const currentMetadata = self.findMetadataByPath(context.nodeId, filepath);
    if (!currentMetadata) {
      return;
    }
    if ((currentMetadata.items || []).length === 0) {
      return;
    }
    self.openDraftModal(currentMetadata);
  }

  self.deleteMetadata = function(context, filepath, item) {
    if (!self.deleteConfirmationDialog) {
      self.deleteConfirmationDialog = self.initConfirmDeleteDialog();
    }
    self.deleteConfirmingFilepath = filepath;
    self.deleteConfirmingContext = context;
    self.deleteConfirmationDialog.modal('show');
  }

  /**
   * Resolve missing metadata
   */
  self.resolveMetadataConsistency = function(context, metadata) {
    if (!self.resolveConsistencyDialog) {
      self.resolveConsistencyDialog = self.createResolveConsistencyDialog();
    }
    self.currentContext = context;
    self.currentMetadata = metadata;
    const container = self.resolveConsistencyDialog.container;
    self.resolveConsistencyDialog.copyStatus.text('');
    const activeItems = (metadata.items || []).filter(function(item_) {
      return item_.active;
    });
    const targetItem = activeItems[0] || metadata.items[0];
    const selector = self.createSchemaSelector(targetItem);
    self.currentSchemaId = selector.currentSchemaId;
    const reviewFields = $('<div></div>')
      .css('overflow-y', 'scroll')
      .css('height', '40vh');
    const draftSelection = $('<div></div>').text(_('Loading...'));
    selector.schema.change(function(event) {
      self.currentSchemaId = event.target.value;
      self.prepareReviewFields(
        reviewFields,
        draftSelection,
        self.findSchemaById(self.currentSchemaId),
        targetItem
      );
    });
    container.empty();
    const message = $('<div></div>');
    message.text(_('Select the destination of the file metadata.'));
    container.append(message);
    const targetContainer = $('<div></div>').text(_('Loading...'));
    container.append(targetContainer);
    const metadataMessage = $('<div></div>');
    metadataMessage.text(_('Current Metadata:')).css('margin-top', '1em');
    container.append(metadataMessage);
    container.append(selector.group);
    container.append(reviewFields);
    self.prepareReviewFields(
      reviewFields,
      draftSelection,
      self.findSchemaById(self.currentSchemaId),
      targetItem
    );
    context.wbcache.listFiles(null, true)
      .then(function(files) {
        const tasks = files.map(function(file) {
          const item = file.item;
          return context.wbcache.computeHash({
            data: Object.assign({}, item.attributes, {
              links: item.links,
            }),
            kind: item.attributes.kind
          });
        });
        self.targetFiles = files;
        Promise.all(tasks)
          .then(function(hashes) {
            targetContainer.empty();
            var items = 0;
            files.forEach(function(file, fileIndex) {
              const hash = hashes[fileIndex];
              const kind = metadata.folder ? 'folder' : 'file';
              if (kind !== file.item.attributes.kind) {
                return;
              }
              if (metadata.hash !== hash) {
                return;
              }
              targetContainer.append($('<div></div>')
                .append($('<input></input>')
                  .attr('type', 'radio')
                  .attr('id', 'metadata-target-' + fileIndex)
                  .attr('name', 'metadata-target')
                  .attr('checked', items === 0)
                  .attr('value', file.path))
                .append($('<label></label>')
                  .attr('for', 'metadata-target-' + file.path)
                  .text(file.path)));
              items ++;
            })
            targetContainer.append($('<div></div>')
              .append($('<input></input>')
                .attr('type', 'radio')
                .attr('id', 'metadata-target-none')
                .attr('name', 'metadata-target')
                .attr('checked', items === 0)
                .attr('value', ''))
              .append($('<label></label>')
                .attr('for', 'metadata-target-none')
                .text(_('Delete metadata'))));
          })
          .catch(function(err) {
            $osf.growl('Error', _('Could not list hashes') + ': ' + err.toString());
            Raven.captureMessage(_('Could not list hashes'), {
              extra: {
                error: err.toString()
              }
            });
          });
      })
      .catch(function(err) {
        $osf.growl('Error', _('Could not list files') + ': ' + err.toString());
        Raven.captureMessage(_('Could not list files'), {
          extra: {
            error: err.toString()
          }
        });
      });
    self.resolveConsistencyDialog.dialog.modal('show');
  }

  self.resolveConsistency = function(path) {
    const newMetadata = Object.assign({}, self.currentMetadata, {
      path: path
    });
    const url = self.currentContext.baseUrl + 'files/' + newMetadata.path;
    return new Promise(function(resolve, reject) {
      $.ajax({
        method: 'PATCH',
        url: url,
        contentType: 'application/json',
        data: JSON.stringify(newMetadata)
      }).done(function (data) {
        console.log(logPrefix, 'saved: ', data);
        return $.ajax({
          url: self.currentContext.baseUrl + 'files/' + self.currentMetadata.path,
          type: 'DELETE',
          dataType: 'json'
        }).done(function (data) {
          resolve();
          console.log(logPrefix, 'deleted: ', data);
          window.location.reload();
        }).fail(function(xhr, status, error) {
          reject(error)
          $osf.growl('Error',
            'Error while retrieving addon info for ' + self.currentMetadata.path + ': ' + xhr.status);
          Raven.captureMessage('Error while retrieving addon info', {
            extra: {
              url: url,
              status: status,
              error: error
            }
          });
        });
      }).fail(function(xhr, status, error) {
        reject(error);
        $osf.growl('Error',
          'Error while retrieving addon info for ' + self.currentMetadata.path + ': ' + xhr.status);
        Raven.captureMessage('Error while retrieving addon info', {
          extra: {
            url: url,
            status: status,
            error: error
          }
        });
      });
    });
}

  self.deleteConfirmedModal = function() {
    const filepath = self.deleteConfirmingFilepath;
    const context = self.deleteConfirmingContext;
    self.deleteConfirmingFilepath = null;
    self.deleteConfirmingContext = null;
    console.log(logPrefix, 'delete metadata: ', filepath, context.nodeId);
    const url = context.baseUrl + 'files/' + filepath;
    return new Promise(function(resolve, reject) {
      $.ajax({
        url: url,
        type: 'DELETE',
        dataType: 'json'
      }).done(function (data) {
        console.log(logPrefix, 'deleted: ', data, context.nodeId);
        self.loadMetadata(context.nodeId, context.baseUrl, function() {
          resolve();
          if (!self.fileViewPath) {
            return;
          }
          self.refreshFileViewButtons(self.fileViewPath);
        });
      }).fail(function(xhr, status, error) {
        reject(error);
        $osf.growl('Error',
          'Error while retrieving addon info for ' + filepath + ': ' + xhr.status);
        Raven.captureMessage('Error while retrieving addon info', {
          extra: {
            url: url,
            status: status,
            error: error
          }
        });
      });
    });
  };

  self.extractProjectName = function(metadata) {
    if (!metadata) {
      return _('No name');
    }
    const projectNameJa = metadata['project-name-ja'];
    const projectNameEn = metadata['project-name-en'];
    const projectNameJaValue = projectNameJa ? (projectNameJa.value || null) : null;
    const projectNameEnValue = projectNameEn ? (projectNameEn.value || null) : null;
    if (!projectNameJaValue && !projectNameEnValue) {
      return _('No name');
    }
    if (rdmGettext.getBrowserLang() === 'ja') {
      return projectNameJaValue || projectNameEnValue;
    }
    return projectNameEnValue || projectNameJaValue;
  };

  self.includePathInDraftRegistration = function(context, path, registration) {
    if (!registration.attributes) {
      return false;
    }
    if (!registration.attributes.registration_metadata) {
      return false;
    }
    const files = registration.attributes.registration_metadata['grdm-files'];
    if (!files) {
      return false;
    }
    if (!files.value) {
      return false;
    }
    const fileEntries = JSON.parse(files.value);
    const draftPath = context.nodeId === contextVars.node.id ? path : context.nodeId + '/' + path;
    return fileEntries.filter(function(file) {
      return file.path === draftPath;
    }).length > 0;
  };

  self.createDraftsSelect = function(schema, disabled) {
    const registrations = $('<ul></ul>').css('list-style-type', 'none');
    var empty = true;
    (self.draftRegistrations.registrations || []).forEach(function(r) {
      const registration_schema = r.relationships.registration_schema;
      if (!registration_schema || registration_schema.data.id !== schema.id) {
        return;
      }
      const projectName = self.extractProjectName(r.attributes.registration_metadata);
      const text = $('<label></label>')
        .css('margin-right', '0.5em')
        .attr('for', 'draft-' + r.id)
        .text(projectName);
      if (disabled) {
        text.css('color', '#888');
      }
      registrations.append($('<li></li>')
        .append($('<input></input>')
          .css('margin-right', '0.5em')
          .attr('type', 'checkbox')
          .attr('id', 'draft-' + r.id)
          .attr('name', 'draft-' + r.id)
          .attr('disabled', disabled)
          .attr('checked', self.includePathInDraftRegistration(self.registeringContext, self.registeringFilepath, r)))
        .append(text)
        .append($('<span></span>')
          .attr('id', 'draft-' + r.id + '-link')));
      empty = false;
    });
    // Metadata-supported addons
    self.getMetadataSupportedRegistries().forEach(function(r) {
      if (r.schema !== schema.id) {
        return;
      }
      const text = $('<label></label>')
        .css('margin-right', '0.5em')
        .attr('for', r.id)
        .text(r.name);
      if (disabled) {
        text.css('color', '#888');
      }
      registrations.append($('<li></li>')
        .append($('<input></input>')
          .css('margin-right', '0.5em')
          .attr('type', 'checkbox')
          .attr('id', r.id)
          .attr('name', r.id)
          .attr('disabled', disabled)
          .attr('checked', false))
        .append(text)
        .append($('<span></span>')
          .attr('id', r.id + '-link')));
      empty = false;
    });
    if (empty) {
      registrations.append($('<li></li>')
        .append($('<span></span>').text(_('There is no draft project metadata compliant with the schema. Create new draft project metadata from the Metadata tab:')))
        .append($('<a></a>')
          .text(_('Open'))
          .attr('href', contextVars.node.urls.web + 'metadata'))
      );
    }
    return registrations;
  }

  self.getFileMetadataPageURL = function(draftId) {
    const registrations = (self.draftRegistrations.registrations || []).filter(function(r) {
      return r.id == draftId;
    });
    if (registrations.length == 0) {
      console.error('No registrations', draftId);
      return null;
    }
    const registration = registrations[0];
    const schemaId = (((registration.relationships || {}).registration_schema || {}).data || {}).id;
    if (!schemaId) {
      console.error('No schemas for registration', draftId);
      return null;
    }
    const schema = self.findSchemaById(schemaId);
    if (!schema) {
      console.error('No schemas', schemaId);
      return null;
    }
    const pages = ((schema.attributes || {}).schema || {}).pages || [];
    const filePages = pages
      .map(function(page, pageIndex) {
        return {
          name: '' + (pageIndex + 1) + '-' + page.title,
          page: page
        };
      })
      .filter(function(page) {
        return (page.page.questions || []).filter(function(q) {
          return q.qid == 'grdm-files';
        }).length > 0;
      });
    if (filePages.length == 0) {
      console.error('No pages have grdm-files');
      return null;
    }
    const pageName = filePages[0].name;
    return '/registries/drafts/' + draftId + '/' + encodeURIComponent(pageName) + '?view_only=';
  };

  self.prepareReviewFields = function(container, draftSelectionContainer, schema, metadataItem) {
    self.lastQuestionPage = self.createQuestionPage(
      schema.attributes.schema,
      metadataItem,
      {
        readonly: true,
      }
    );
    self.lastFields = self.lastQuestionPage.fields;
    container.empty();
    self.lastFields.forEach(function(field) {
      container.append(field.element);
    });
    self.lastQuestionPage.validateAll();
    const message = $('<div></div>');
    if (self.lastQuestionPage.hasValidationError) {
      message.text(_('There are errors in some fields.')).css('color', 'red');
    }
    if (self.selectDraftDialog) {
      self.selectDraftDialog.select.attr('disabled', self.lastQuestionPage.hasValidationError);
    }
    draftSelectionContainer.empty();
    draftSelectionContainer.append(message);
    draftSelectionContainer.append(
      self.createDraftsSelect(schema, self.lastQuestionPage.hasValidationError).css('margin', '1em 0')
    );
  };

  self.openDraftModal = function(currentMetadata) {
    if (!self.selectDraftDialog) {
      self.selectDraftDialog = self.initSelectDraftDialog();
    }
    const activeItems = (currentMetadata.items || []).filter(function(item_) {
      return item_.active;
    });
    const targetItem = activeItems[0] || currentMetadata.items[0];
    const selector = self.createSchemaSelector(targetItem);
    self.currentSchemaId = selector.currentSchemaId;
    const reviewFields = $('<div></div>')
      .css('overflow-y', 'scroll')
      .css('height', '40vh');
    const draftSelection = $('<div></div>').text(_('Loading...'));
    selector.schema.change(function(event) {
      self.currentSchemaId = event.target.value;
      self.prepareReviewFields(
        reviewFields,
        draftSelection,
        self.findSchemaById(self.currentSchemaId),
        targetItem
      );
    });
    self.selectDraftDialog.select
      .text(_('Select'))
      .attr('disabled', true)
      .attr('data-dismiss', false);
    const message = $('<div></div>');
    message.text(_('Select the destination for the file metadata.'));
    self.selectDraftDialog.container.empty();
    self.selectDraftDialog.container.append(selector.group);
    self.selectDraftDialog.container.append(message);
    self.selectDraftDialog.container.append(draftSelection);
    self.selectDraftDialog.container.append(reviewFields);
    self.selectDraftDialog.dialog.modal('show');
    self.draftRegistrations.load(function() {
      self.prepareReviewFields(
        reviewFields,
        draftSelection,
        self.findSchemaById(self.currentSchemaId),
        targetItem
      );
    });
  };

  self.getMetadataSupportedRegistries = function() {
    return (self.contexts[contextVars.node.id].projectMetadata.repositories || [])
      .map(function(repo) {
        return repo.registries || [];
      })
      .reduce(function(x, y) {
        var r = [];
        x.forEach(function(e) {
          r.push(e);
        });
        y.forEach(function(e) {
          r.push(e);
        });
        return r;
      }, []);
  }

  self.getRegistrationURL = function(draftId, nodeId, filepath) {
    console.log('URL', self.baseUrl);
    // Metadata-supported addons
    const regs = self.getMetadataSupportedRegistries()
      .filter(function(reg) {
        return reg.id === draftId;
      });
    if (regs.length > 0) {
      return regs[0].url + '/' + nodeId + '/' + filepath;
    }
    return self.baseUrl + 'draft_registrations/' + draftId + '/files/' + nodeId + '/' + filepath;
  };

  self.updateRegistrationAsync = function(context, checked, filepath, draftId, link) {
    return new Promise(function(resolve, perror) {
      console.log(logPrefix, 'register metadata: ', filepath, draftId);
      const url = self.getRegistrationURL(draftId, context.nodeId, filepath);
      link.text(checked ? _('Registering...') : _('Deleting...'));
      osfBlock.block();
      return $.ajax({
          url: url,
          type: checked ? 'PUT' : 'DELETE',
          dataType: 'json'
      }).done(function (data) {
        if (data.data && data.data.attributes && data.data.attributes.progress_url) {
          self.waitForRegistration(
            data.data.attributes.progress_url,
            function(data, result) {
              osfBlock.unblock();
              link.empty();
              link.append($('<a></a>')
                .text(_('Open'))
                .attr('href', result));
              resolve(data);
            },
            function(url, xhr, status, error) {
              osfBlock.unblock();
              perror(url, xhr, status, error);
            }
          );
          return;
        }
        osfBlock.unblock();
        link.empty();
        link.append($('<a></a>')
          .text(_('Open'))
          .attr('href', self.getFileMetadataPageURL(draftId)));
        resolve(data);
      }).fail(function(xhr, status, error) {
        osfBlock.unblock();
        perror(url, xhr, status, error);
      });
    });
  };

  self.waitForRegistration = function(url, resolve, perror) {
    setTimeout(function() {
      $.ajax({
        url: url,
        type: 'GET',
        dataType: 'json'
      }).done(function (data) {
        if (data.data && data.data.attributes && data.data.attributes.result) {
          console.log(logPrefix, 'Finished', data);
          resolve(data, data.data.attributes.result);
          return;
        }
        console.log(logPrefix, 'Processing...', data);
        self.waitForRegistration(url, resolve, perror);
      }).fail(function(xhr, status, error) {
        if (status === 'error' && error === 'NOT FOUND') {
          self.waitForRegistration(url, resolve, perror);
          return;
        }
        perror(url, xhr, status, error);
      });
    }, 500);
  };

  self.selectDraftModal = function() {
    const filepath = self.registeringFilepath;
    const context = self.registeringContext;
    if (!filepath) {
      return;
    }
    self.registeringFilepath = null;
    self.registeringContext = null;
    const ops = [];
    (self.draftRegistrations.registrations || []).forEach(function(r) {
      const checkbox = self.selectDraftDialog.container.find('#draft-' + r.id);
      const checked = checkbox.is(':checked');
      const oldChecked = self.includePathInDraftRegistration(context, filepath, r);
      if (checked == oldChecked) {
        return;
      }
      const link = self.selectDraftDialog.container.find('#draft-' + r.id + '-link');
      ops.push(self.updateRegistrationAsync(context, checked, filepath, r.id, link));
    });
    // Metadata-supported addons
    self.getMetadataSupportedRegistries().forEach(function(r) {
      const checkbox = self.selectDraftDialog.container.find('#' + r.id);
      const checked = checkbox.is(':checked');
      if (checked) {
        const link = self.selectDraftDialog.container.find('#' + r.id + '-link');
        ops.push(self.updateRegistrationAsync(context, checked, filepath, r.id, link));
      }
    });
    Promise.all(ops)
      .then(function(data) {
        console.log(logPrefix, 'updated: ', data);
        self.selectDraftDialog.select
          .text(_('Close'))
          .attr('data-dismiss', 'modal');
        self.draftRegistrations.load();
      })
      .catch(function(url, xhr, status, error) {
        $osf.growl('Error', 'Error while retrieving addon info for ' + filepath + ': ' + xhr.status);
        Raven.captureMessage('Error while retrieving addon info', {
            extra: {
                url: url,
                status: status,
                error: error
            }
        });
      });
  };

  self.createFangornButtons = function(filepath, item) {
    return self.createButtonsBase(
      filepath,
      item,
      function(options, label) {
        return m.component(Fangorn.Components.button, options, label);
      }
    );
  }

  self.createButtonsBase = function(filepath, item, createButton) {
    const context = self.findContextByNodeId(item ? item.data.nodeId : contextVars.node.id);
    if (!context) {
      console.warn('Metadata not loaded for project:', item ? item.data.nodeId : null);
      const loadingButton = self.createLoadingButton(createButton);
      return [loadingButton];
    }
    if (!context.addonAttached) {
      return [];
    }
    const projectMetadata = context.projectMetadata;
    const currentMetadatas = projectMetadata.files.filter(function(f) {
      return f.path === filepath;
    });
    const currentMetadata = currentMetadatas[0] || null;
    const extraMetadata = self.getExtraMetadata(item);
    if (extraMetadata === null) {
      return [];
    }
    if (item && item.data.kind === 'folder' && item.data.addonFullname) {
      // provider
      const repos = (projectMetadata.repositories || []).filter(function(repo) {
        return repo.metadata && repo.metadata.provider === item.data.provider;
      });
      if (repos.length > 0 && !(repos[0].metadata.permissions || { provider: true }).provider) {
        return [];
      }
    }
    if (!projectMetadata.editable || extraMetadata) {
      // readonly
      const filepath = item.data.provider + (item.data.materialized || '/');
      const metadata = extraMetadata || self.findMetadataByPath(context.nodeId, filepath);
      if (!metadata) {
        return [];
      }
      const viewButton = createButton({
        onclick: function(event) {
          self.editMetadata(context, filepath, item);
        },
        icon: 'fa fa-edit',
        className : 'text-primary'
      }, _('View Metadata'));
      return [viewButton];
    }
    const buttons = [];
    if (self.isMetadataEditable(item)) {
      const editButton = createButton({
        onclick: function(event) {
          self.editMetadata(context, filepath, item);
        },
        icon: 'fa fa-edit',
        className : 'text-primary'
      }, _('Edit Metadata'));
      buttons.push(editButton);
    }
    if (currentMetadata) {
      if (self.isMetadataRegisterable(item)) {
        const registerButton = createButton({
          onclick: function(event) {
            self.registerMetadata(context, filepath, item);
          },
          icon: 'fa fa-external-link',
          className : 'text-success'
        }, _('Register Metadata'));
        buttons.push(registerButton);
      }
      if (self.isMetadataEditable(item)) {
        const deleteButton = createButton({
          onclick: function(event) {
            self.deleteMetadata(context, filepath, item);
          },
          icon: 'fa fa-trash',
          className : 'text-danger'
        }, _('Delete Metadata'));
        buttons.push(deleteButton);
      }
    }
    return buttons;
  }

  self.createFangornMultipleItemsButtons = function(filepaths, items) {
    return self.createMultipleItemsButtonsBase(
      filepaths,
      items,
      function(options, label) {
        return m.component(Fangorn.Components.button, options, label);
      }
    );
  }

  self.createMultipleItemsButtonsBase = function(filepaths, items, createButton) {
    // assert filepaths.length > 1
    // assert filepaths.length == items.length
    const contexts = items.map(function(item) {
      return self.findContextByNodeId(item ? item.data.nodeId : contextVars.node.id);
    });
    const context = contexts[0];
    if (!context) {
      console.warn('Metadata not loaded for project:', items[0] ? items[0].data.nodeId : null);
      const loadingButton = self.createLoadingButton(createButton);
      return [loadingButton];
    }
    if (!context.addonAttached) {
      return [];
    }
    if (contexts.slice(1).filter(function(context) {
      return context !== contexts[0];
    }).length > 0) {
      // unmatched contexts
      return [];
    }
    const projectMetadata = context.projectMetadata;
    const extraMetadatas = items.map(function(item) {
      return self.getExtraMetadata(item);
    });
    if (!projectMetadata.editable || extraMetadatas.some(function(m) {
      return m;
    })) {
      // readonly
      return [];
    }
    const editButton = createButton({
      onclick: function(event) {
        self.editMultipleMetadata(context, filepaths, items);
      },
      icon: 'fa fa-edit',
      className : 'text-primary'
    }, _('Edit Multiple Metadata'));
    return [editButton];
  }

  self.createLoadingButton = function(createButton) {
    const viewButton = createButton({
      onclick: function(event) {
      },
      icon: 'fa fa-spinner fa-pulse',
      className : 'text-default disabled'
    }, _('Loading Metadata'));
    viewButton.disabled = true;
    return viewButton;
  }

  /**
   * Register existence-verified metadata.
   */
  self.setValidatedFile = function(context, filepath, item, metadata) {
    const cache = context.validatedFiles[filepath];
    if (cache && cache.expired > Date.now() && cache.item !== null) {
      return;
    }
    context.validatedFiles[filepath] = {
      expired: Date.now() + METADATA_CACHE_EXPIRATION_MSEC,
      item: item,
      metadata: metadata,
    };
    context.wbcache.computeHash(item)
      .then(function(hash) {
        if (metadata.hash === hash) {
          return;
        }
        // Update the hash
        console.log(logPrefix, 'Updating hash', metadata, hash);
        const url = self.baseUrl + 'hashes/' + metadata.path;
        $.ajax({
          method: 'PATCH',
          url: url,
          contentType: 'application/json',
          data: JSON.stringify({
            hash: hash
          })
        }).done(function (data) {
          console.log(logPrefix, 'saved: ', hash, data);
          context.validatedFiles[filepath] = {
            expired: Date.now() + METADATA_CACHE_EXPIRATION_MSEC,
            item: item,
            metadata: Object.assign({}, metadata, {
              hash: hash
            })
          };
        }).fail(function(xhr, status, error) {
          $osf.growl('Error', 'Error while saving addon info for ' + filepath + ': ' + xhr.status);
          Raven.captureMessage('Error while saving addon info', {
              extra: {
                  url: url,
                  status: status,
                  error: error
              }
          });
        });
      })
      .catch(function(error) {
      });
  };

  /**
   * Verify the existence of metadata.
   */
  self.validateFile = function(context, filepath, metadata, callback) {
    const cache = context.validatedFiles[filepath];
    if (cache && cache.expired > Date.now()) {
      if (cache.loading) {
        return;
      }
      callback(cache.item);
      return;
    }
    context.validatedFiles[filepath] = {
      expired: Date.now() + METADATA_CACHE_EXPIRATION_MSEC,
      item: null,
      loading: true,
      metadata: metadata
    };
    console.log(logPrefix, 'Checking metadata', filepath, metadata);
    setTimeout(function() {
      context.wbcache.searchFile(filepath, function(file) {
        console.log(logPrefix, 'Search result', filepath, file);
        context.validatedFiles[filepath] = {
          expired: Date.now() + METADATA_CACHE_EXPIRATION_MSEC,
          item: file,
          loading: false,
          metadata: metadata,
        };
        callback(file);
      });
    }, 1000);
  };

  /**
   * Modifies row data.
   */
  self.decorateRows = function(items) {
    if (items.length === 0) {
      return;
    }
    const remains = items.filter(function(item) {
      return item.data && item.data.nodeApiUrl;
    }).filter(function(item) {
      const text = $('.td-title.tb-td[data-id="' + item.id + '"] .title-text');
      if (text.length === 0) {
        return true;
      }
      const context = self.findContextByNodeId(item.data.nodeId);
      if (!context) {
        self.loadMetadata(item.data.nodeId, item.data.nodeApiUrl + 'metadata/');
        return true;
      }
      if (!item.data.materialized) {
        context.wbcache.setProvider(item);
      }
      var indicator = text.find('.metadata-indicator');
      if (indicator.length === 0) {
        indicator = $('<span></span>')
          .addClass('metadata-indicator')
          .css('margin-left', '1em');
        text.append(indicator);
      } else {
        indicator.empty();
      }
      const filepath = item.data.provider + (item.data.materialized || '/');
      const extraMetadata = self.getExtraMetadata(item);
      const metadata = extraMetadata || self.findMetadataByPath(context.nodeId, filepath);
      const projectMetadata = context.projectMetadata;
      if (!metadata && filepath.length > 0 && filepath[filepath.length - 1] !== '/') {
        // file with no metadata
        indicator.empty();
        return false;
      }
      const childMetadata = projectMetadata.files.filter(function(f) {
        return f.path.substring(0, filepath.length) === filepath;
      });
      if (!metadata && childMetadata.length === 0) {
        // folder with no metadata
        return false;
      }
      if (metadata) {
        indicator.append($('<span></span>')
          .text('{}')
          .css('font-weight', 'bold')
          .css('margin', '0 8px')
          .attr('title', _('Metadata is defined')));
        self.setValidatedFile(context, filepath, item, metadata);
      } else {
        indicator.append($('<span></span>')
          .text('{}')
          .css('font-weight', 'bold')
          .css('margin', '0 8px')
          .css('color', '#ccc')
          .attr('title', _('Some of the children have metadata.')));
      }
      childMetadata.forEach(function (child) {
        self.validateFile(context, child.path, child, function(item) {
          if (item) {
            return;
          }
          const ic = $('<span></span>')
            .append($('<i></i>')
              .addClass('fa fa-exclamation-circle')
              .attr('title', _('File not found: ') + child.path))
            .on('click', function() {
              if (!((context.projectMetadata || {}).editable)) {
                return;
              }
              self.resolveMetadataConsistency(context, child);
            });
          indicator.append(ic);
        });
      });
      return false;
    });
    if (remains.length === 0) {
      return;
    }
    setTimeout(function() {
      self.decorateRows(remains);
    }, 1000);
  }

  self.initBase = function(callback) {
    self.loadConfig(callback);
  }

  /**
   * Refresh buttons for file view.
   */
  self.refreshFileViewButtons = function(path) {
    if (!self.fileViewButtons) {
      self.fileViewButtons = $('<div></div>')
        .addClass('btn-group m-t-xs')
        .attr('id', 'metadata-toolbar');
    }
    self.fileViewPath = path;
    const buttons = self.fileViewButtons;
    buttons.empty();
    self.createButtonsBase(
      path,
      self.getFileItemFromContext(),
      function(options, label) {
        const btn = $('<button></button>')
          .addClass('btn')
          .addClass('btn-sm');
        if (options.className) {
          btn.addClass(options.className.replace(/^text-/, 'btn-'));
        }
        if (options.icon) {
          btn.append($('<i></i>').addClass(options.icon));
        }
        if (options.onclick) {
          btn.click(options.onclick);
        }
        btn.append($('<span></span>').text(label));
        return btn;
      }
    )
      .forEach(function(button) {
        buttons.append(button);
      });
    $('#toggleBar .btn-toolbar').append(buttons);
  };

  self.initFileView = function() {
    var path = null;
    function refreshIfToolbarExists() {
      const toolbar = $('#toggleBar .btn-toolbar');
      if (toolbar.length > 0) {
        self.refreshFileViewButtons(path);
      }
    }
    const observer = new MutationObserver(refreshIfToolbarExists);
    const toggleBar = $('#toggleBar').get(0);
    observer.observe(toggleBar, {attributes: false, childList: true, subtree: false});

    function resolveRows(items) {
      if (items.length === 0) {
        return;
      }
      const remains = items.filter(function(item) {
        const text = $('.td-title.tb-td[data-id="' + item.id + '"] .title-text');
        if (text.length === 0) {
          return true;
        }
        const context = self.findContextByNodeId(item.data.nodeId);
        if (!context) {
          self.loadMetadata(item.data.nodeId, item.data.nodeApiUrl + 'metadata/');
          return true;
        }
        if (!item.data.materialized) {
          context.wbcache.setProvider(item);
        }
        return false;
      });
      if (remains.length === 0) {
        return;
      }
      setTimeout(function() {
        resolveRows(remains);
      }, 1000);
    }

    self.initBase(function(p) {
      path = p;
      refreshIfToolbarExists();
      resolveRows(self.reservedRows);
    });

    Fangorn.config = new Proxy(Fangorn.config, {
      get: function(targetprov, name) {
        var obj = targetprov[name];
        if (obj === undefined) {
          obj = {};
        }
        return new Proxy(obj, {
          get: function(target, propname) {
            if (propname == 'resolveRows') {
              return function(item) {
                var base = null;
                if (target[propname] !== undefined) {
                  const prop = target[propname];
                  const baseRows = typeof prop === 'function' ? prop.apply(this, [item]) : prop;
                  if (baseRows !== undefined) {
                    base = baseRows;
                  }
                }
                if (self.contexts) {
                  setTimeout(function() {
                    resolveRows([item]);
                  }, 500);
                } else {
                  self.reservedRows.push(item);
                }
                return base;
              };
            } else {
              return target[propname];
            }
          }
        });
      }
    });
  }

  self.notifyMoveComplete = function(item, nodeId, metadata) {
    self.moveCompleteHandlers.forEach(function(handler) {
      handler(item, nodeId, metadata);
    });
  };

  self.initFileTree = function() {
    self.initBase(function() {
      const items = self.reservedRows;
      setTimeout(function() {
        self.decorateRows(items);
      }, 500);
    });

    Fangorn.config = new Proxy(Fangorn.config, {
      get: function(targetprov, name) {
        var obj = targetprov[name];
        if (obj === undefined) {
          obj = {};
        }
        return new Proxy(obj, {
          get: function(target, propname) {
            if (propname == 'itemButtons') {
              return function(item) {
                var base = Fangorn.Components.defaultItemButtons;
                if (target[propname] !== undefined) {
                  const prop = target[propname];
                  const baseButtons = typeof prop === 'function' ? prop.apply(this, [item]) : prop;
                  if (baseButtons !== undefined) {
                    base = baseButtons;
                  }
                }
                const filepath = item.data.provider + (item.data.materialized || '/');
                const buttons = self.createFangornButtons(filepath, item);
                return {
                  view : function(ctrl, args, children) {
                    const tb = args.treebeard;
                    const mode = tb.toolbarMode;
                    if (tb.options.placement === 'fileview') {
                      return m('span', []);
                    }
                    const viewButtons = [
                      m.component(base, {treebeard : tb, mode : mode,
                                  item : item }),
                    ].concat(buttons);
                    if (item.kind === 'folder' && !item.data.addonFullname) {
                      const importDatasetButton = new ImportDatasetButton(
                        tb,
                        item,
                        self.contexts,
                        {
                          assign: function() {
                            return tempIdCounterForDataset ++;
                          }
                        }
                      );
                      if (importDatasetButton.isAvailable()) {
                        viewButtons.push(importDatasetButton.createButton());
                      }
                    }
                    return m('span', viewButtons);
                  }
                };
              };
            } if (propname == 'multipleItemsButtons') {
              return function (items) {
                var base = [];
                if (target[propname] !== undefined) {
                  const prop = target[propname];
                  const baseButtons = typeof prop === 'function' ? prop.apply(this, [items]) : prop;
                  if (baseButtons !== undefined) {
                    base = baseButtons;
                  }
                }
                const filepaths = items.map(function(item) {
                  return item.data.provider + (item.data.materialized || '/');
                });
                const buttons = self.createFangornMultipleItemsButtons(filepaths, items);
                return base.concat(buttons);
              }
            } else if (propname == 'resolveRows') {
              return function(item) {
                var base = null;
                if (target[propname] !== undefined) {
                  const prop = target[propname];
                  const baseRows = typeof prop === 'function' ? prop.apply(this, [item]) : prop;
                  if (baseRows !== undefined) {
                    base = baseRows;
                  }
                }
                if (self.contexts) {
                  setTimeout(function() {
                    self.decorateRows([item]);
                  }, 500);
                } else {
                  self.reservedRows.push(item);
                }
                return base;
              };
            } else if (propname == 'onMoveComplete') {
              return function (item, from) {
                const context = self.findContextByNodeId(from.data.nodeId);
                if (!context) {
                  return;
                }
                const fromFilepath = from.data.provider + (from.data.materialized || '/');
                const projectMetadata = context.projectMetadata;
                var fromFilepaths = projectMetadata.files
                  .map(function(f) { return f.path; })
                  .filter(function(p) {
                    return p.substring(0, fromFilepath.length) === fromFilepath;
                  });
                if (!fromFilepaths.length) {
                  return;
                }
                const toFilepath = item.data.provider + (item.data.materialized || '/');
                var toFilepaths = fromFilepaths
                  .map(function(p) {
                    return toFilepath + p.replace(fromFilepath, '');
                  });
                const toNodeId = item.data ? item.data.nodeId : null;
                const fromNodeId = from.data ? from.data.nodeId : null;
                if (!toNodeId) {
                  console.log(logPrefix, 'toNodeId is null');
                  return;
                }
                if (!fromNodeId) {
                  console.log(logPrefix, 'fromNodeId is null');
                  return;
                }
                var toContext = self.findContextByNodeId(toNodeId);
                var fromContext = self.findContextByNodeId(fromNodeId);
                if (!toContext) {
                  console.log(logPrefix, 'toContext is null');
                  return;
                }
                if (!fromContext) {
                  console.log(logPrefix, 'fromContext is null');
                  return;
                }
                // try reload project metadata
                const interval = 250;
                const maxRetry = 10;
                const intervalIncrease = 250;
                var retry = 0;
                function tryLoadMetadata() {
                  // Retrieve metadata for the destination project
                  self.loadMetadata(toContext.nodeId, toContext.baseUrl, function() {
                    const toProjectMetadata = self.findProjectMetadataByNodeId(toContext.nodeId);
                    const matches = toFilepaths
                      .map(function(p) {
                        return toProjectMetadata.files.find(function(f) { return f.path === p; });
                      });
                    const unmatchCount = matches.filter(function(m) { return !m; }).length;
                    console.log(logPrefix, 'reloaded metadata: ', {
                      context: toContext,
                      unmatchCount: unmatchCount,
                      expectedFilepaths: toFilepaths
                    });
                    self.notifyMoveComplete(item, toContext.nodeId, toProjectMetadata);
                    if (!unmatchCount) {
                      // Retrieve metadata for the source project
                      self.loadMetadata(fromContext.nodeId, fromContext.baseUrl, function() {
                        const fromProjectMetadata = self.findProjectMetadataByNodeId(fromContext.nodeId);
                        const matches = fromFilepaths
                          .map(function(p) {
                            return fromProjectMetadata.files.find(function(f) { return f.path === p; });
                          });
                        const matchCount = matches.filter(function(m) { return m; }).length;
                        console.log(logPrefix, 'reloaded metadata: ', {
                          context: fromContext,
                          matchCount: matchCount,
                          expectedFilepaths: fromFilepaths
                        });
                        toContext.wbcache.clearCache();
                        m.redraw();
                        self.notifyMoveComplete(from, fromContext.nodeId, fromProjectMetadata);
                      });
                      return;
                    }
                    retry += 1;
                    if (retry >= maxRetry) {
                      console.log(logPrefix, 'failed retry reloading metadata');
                      return;
                    }
                    console.log(logPrefix, retry + 'th retry reload metadata after ' + interval + 'ms: ');
                    setTimeout(tryLoadMetadata, interval + retry * intervalIncrease);
                  });
                }
                setTimeout(tryLoadMetadata, interval);
              }
            } else {
              return target[propname];
            }
          }
        });
      }
    });
  };

  /**
   * Save the edited metadata.
   */
  self.saveEditMetadataModal = function() {
    const metadata = Object.assign({}, self.lastMetadata);
    const context = self.editingContext;
    metadata.items = (self.lastMetadata.items || [])
      .filter(function(item) {
        return item.schema != self.currentSchemaId;
      })
      .map(function(item) {
        return Object.assign({}, item, {
          active: false
        });
      });
    if (self.currentSchemaId) {
      const metacontent = {
        schema: self.currentSchemaId,
        active: true,
        data: {},
      };
      self.lastFields.forEach(function(field) {
        metacontent.data[field.question.qid] = {
          extra: [],
          comments: [],
          value: field.getValue()
        };
      });
      metadata.items.unshift(metacontent);
    }
    return new Promise(function(resolve, reject) {
      context.wbcache.computeHash(self.currentItem)
        .then(function(hash) {
          const url = context.baseUrl + 'files/' + metadata.path;
          $.ajax({
            method: 'PATCH',
            url: url,
            contentType: 'application/json',
            data: JSON.stringify(Object.assign({}, metadata, {
              hash: hash,
            })),
          }).done(function (data) {
            console.log(logPrefix, 'saved: ', hash, data);
            self.currentItem = null;
            self.editingContext = null;
            self.loadMetadata(context.nodeId, context.baseUrl, function() {
              resolve();
              if (!self.fileViewPath) {
                return;
              }
              self.refreshFileViewButtons(self.fileViewPath);
            });
          }).fail(function(xhr, status, error) {
            reject(error);
            $osf.growl('Error', 'Error while retrieving addon info for ' + metadata.path + ': ' + xhr.status);
            Raven.captureMessage('Error while retrieving addon info', {
              extra: {
                url: url,
                status: status,
                error: error
              }
            });
          });
        })
        .catch(function(error) {
          reject(error);
          self.currentItem = null;
        });
    });
  };

  /**
   * Save the edited multiple metadata.
   */
  self.saveEditMultipleMetadataModal = function() {
    const context = self.editingContext;
    if (!self.currentSchemaId) {
      return Promise.resolve();
    }
    const metadatas = self.lastMetadata.path
      .map(function(filepath, i) {
        const currentMetadata = self.findMetadataByPath(context.nodeId, filepath);
        const metadata = Object.assign({}, currentMetadata);
        if (!currentMetadata) {
          metadata.path = filepath;
          metadata.folder = self.currentItem[i].kind === 'folder';
        }
        const currentItems = metadata.items || [];
        // inactivate old items
        metadata.items = currentItems
          .filter(function(item) {
            return item.schema !== self.currentSchemaId;
          })
          .map(function(item) {
            return Object.assign({}, item, {
              active: false
            });
          });
        // create new item
        const oldMetacontent = currentItems
          .filter(function(item) {
            return item.schema === self.currentSchemaId;
          })[0] || {};
        const metacontent = {
          schema: self.currentSchemaId,
          active: true,
          data: Object.assign({}, oldMetacontent.data),
        };
        self.lastFields.forEach(function(field) {
          const value = field.getValue();
          const clear = field.checkedClear();
          const qid = field.question.qid;
          if (clear) {
            delete metacontent.data[qid];
          } else if (value) {
            metacontent.data[qid] = {
              extra: [],
              comments: [],
              value: value
            };
          }
        });
        metadata.items.unshift(metacontent);
        return metadata;
      });
    return Promise.all(self.currentItem.map(function(fileitem) {
      return context.wbcache.computeHash(fileitem);
    }))
      .catch(function(error) {
        self.currentItem = null;
        return Promise.reject(error);
      })
      .then(function(hashes) {
        return new Promise(function(resolve, reject) {
          function patchTopMetadata() {
            const metadata = metadatas.pop();
            const hash = hashes.pop();
            const url = context.baseUrl + 'files/' + metadata.path;
            $.ajax({
              method: 'PATCH',
              url: url,
              contentType: 'application/json',
              data: JSON.stringify(Object.assign({}, metadata, {
                hash: hash,
              })),
            }).done(function(data) {
              console.log(logPrefix, 'saved: ', hash, data);
              if (metadatas.length) {
                patchTopMetadata();
              } else {
                resolve();
              }
            }).fail(function(xhr, status, error) {
              $osf.growl('Error', 'Error while retrieving addon info for ' + metadata.path + ': ' + xhr.status);
              Raven.captureMessage('Error while retrieving addon info', {
                extra: {
                  url: url,
                  status: status,
                  error: error
                }
              });
              reject(error);
            });
          }
          patchTopMetadata();
        });
      })
      .then(function() {
        self.currentItem = null;
        self.editingContext = null;
        return new Promise(function(resolve) {
          self.loadMetadata(context.nodeId, context.baseUrl, function() {
            if (self.fileViewPath) {
              self.refreshFileViewButtons(self.fileViewPath);
            }
            resolve();
          });
        });
      });
  };

  self.closeModal = function() {
    console.log(logPrefix, 'Modal closed');
    self.deleteConfirmingFilepath = null;
    self.deleteConfirmingContext = null;
    self.editingContext = null;
  };

  /**
   * Create the Edit Metadata dialog.
   */
  self.initEditMetadataDialog = function(editable) {
    const dialog = $('<div class="modal fade" data-backdrop="static"></div>');
    const close = $('<a href="#" class="btn btn-default" data-dismiss="modal"></a>').text(_('Close'));
    close.click(self.closeModal);
    var save = $('<span></span>');
    if (editable) {
      save = $('<a href="#" class="btn btn-success"></a>').text(_('Save'));
      save.click(function() {
        osfBlock.block();
        self.saveEditMetadataModal()
          .finally(function() {
            osfBlock.unblock();
            $(dialog).modal('hide');
          })
      });
    }
    const copyToClipboard = $('<button class="btn btn-default"></button>')
      .append($('<i></i>').addClass('fa fa-copy'))
      .append(_('Copy to clipboard'))
      .attr('type', 'button');
    const copyStatus = $('<div></div>')
      .css('text-align', 'left');
    copyToClipboard.on('click', function(event) {
      self.copyToClipboard(event, copyStatus);
    });
    const toolbar = $('<div></div>');
    const customHandler = $('<span></span>');
    const container = $('<ul></ul>').css('padding', '0 20px');
    var notice = $('<span></span>');
    if (editable) {
      notice = $('<div></div>')
        .css('text-align', 'left')
        .css('padding', '0.2em 0.2em 0.2em 1em')
        .css('color', 'red')
        .text(_('Renaming, moving the file/directory, or changing the directory hierarchy can break the association of the metadata you have added.'));
    }
    dialog
      .append($('<div class="modal-dialog modal-lg"></div>')
        .append($('<div class="modal-content"></div>')
          .append($('<div class="modal-header"></div>')
            .append($('<h3></h3>').text(editable ? _('Edit File Metadata') : _('View File Metadata'))))
          .append($('<form></form>')
            .append($('<div class="modal-body"></div>')
              .append($('<div class="row"></div>')
                .append($('<div class="col-sm-12"></div>')
                  .append(toolbar))
                .append($('<div class="col-sm-12"></div>')
                  .css('overflow-y', 'scroll')
                  .css('height', '70vh')
                  .append(container))))
            .append($('<div class="modal-footer"></div>')
              .css('display', 'flex')
              .css('align-items', 'center')
              .append(copyToClipboard.css('margin-left', 0).css('margin-right', 0))
              .append(copyStatus.css('margin-left', 0).css('margin-right', 'auto'))
              .append(notice)
              .append(close)
              .append(save)
              .append(customHandler)))));
    $(window).on('beforeunload', function() {
      if ($(dialog).data('bs.modal').isShown) {
        return _('You have unsaved changes.');
      }
    });
    dialog.appendTo($('#treeGrid'));
    return {
      dialog: dialog,
      container: container,
      toolbar: toolbar,
      copyStatus: copyStatus,
      customHandler: editable ? customHandler : null,
    };
  };


  /**
   * Create the Edit Multiple Metadata dialog.
   */
  self.initEditMultipleMetadataDialog = function() {
    const dialog = $('<div class="modal fade" data-backdrop="static"></div>');
    const close = $('<a href="#" class="btn btn-default" data-dismiss="modal"></a>').text(_('Close'));
    close.click(self.closeModal);
    const save = $('<a href="#" class="btn btn-success"></a>').text(_('Save'));
    save.click(function() {
      osfBlock.block();
      self.saveEditMultipleMetadataModal()
        .finally(function() {
          osfBlock.unblock();
          $(dialog).modal('hide');
      });
    });
    const toolbar = $('<div></div>');
    const container = $('<ul></ul>').css('padding', '0 20px');
    dialog
      .append($('<div class="modal-dialog modal-lg"></div>')
        .append($('<div class="modal-content"></div>')
          .append($('<div class="modal-header"></div>')
            .append($('<h3></h3>').text(_('Edit Multiple File Metadata'))))
          .append($('<form></form>')
            .append($('<div class="modal-body"></div>')
              .append($('<div class="row"></div>')
                .append($('<div class="col-sm-12"></div>')
                  .append(toolbar))
                .append($('<div class="col-sm-12"></div>')
                  .css('overflow-y', 'scroll')
                  .css('height', '70vh')
                  .append(container))))
            .append($('<div class="modal-footer"></div>')
              .css('display', 'flex')
              .css('align-items', 'center')
              .append(close.css('margin-left', 'auto'))
              .append(save)))));
    $(window).on('beforeunload', function() {
      if ($(dialog).data('bs.modal').isShown) {
        return _('You have unsaved changes.');
      }
    });
    dialog.appendTo($('#treeGrid'));
    return {
      dialog: dialog,
      container: container,
      toolbar: toolbar,
    };
  };

  self.initConfirmDeleteDialog = function() {
    const dialog = $('<div class="modal fade"></div>');
    const close = $('<a href="#" class="btn btn-default" data-dismiss="modal"></a>').text(_('Close'));
    close.click(self.closeModal);
    /*
      Workaround: Cannot use .modal-footer here, because .modal-footer .btn-danger combination
      may be unintentionally manipulated by Fangorn
    */
    const del = $('<a href="#" class="btn btn-danger" style="margin-left: 5px"></a>').text(_('Delete'));
    del.click(function() {
      osfBlock.block()
      self.deleteConfirmedModal()
        .finally(function() {
          osfBlock.unblock()
          $(dialog).modal('hide');
        });
    });
    dialog
      .append($('<div class="modal-dialog modal-lg"></div>')
        .append($('<div class="modal-content"></div>')
          .append($('<div class="modal-header"></div>')
            .append($('<h3></h3>').text(_('Delete File Metadata'))))
          .append($('<form></form>')
            .append($('<div class="modal-body"></div>')
              .append($('<div class="row"></div>')
                .append($('<div class="col-sm-12"></div>')
                  .append(_('Do you want to delete metadata? This operation cannot be undone.')))))
            .append($('<div style="padding: 15px; text-align: right;"></div>')
              .append(close).append(del)))));
    dialog.appendTo($('#treeGrid'));
    return dialog;
  };

  self.initSelectDraftDialog = function() {
    var close = $('<a href="#" class="btn btn-default" data-dismiss="modal"></a>').text(_('Close'));
    close.click(self.closeModal);
    var select = $('<a href="#" class="btn btn-success"></a>').text(_('Select'));
    select.click(self.selectDraftModal);
    var container = $('<ul></ul>').css('padding', '0 20px');
    var dialog = $('<div class="modal fade"></div>')
      .append($('<div class="modal-dialog modal-lg"></div>')
        .append($('<div class="modal-content"></div>')
          .append($('<div class="modal-header"></div>')
            .append($('<h3></h3>').text(_('Select a destination for file metadata registration'))))
          .append($('<form></form>')
            .append($('<div class="modal-body"></div>')
              .append($('<div class="row"></div>')
                .append($('<div class="col-sm-12"></div>')
                  .append(container))))
            .append($('<div class="modal-footer"></div>')
              .append(close).append(select)))));
    dialog.appendTo($('#treeGrid'));
    return {dialog: dialog, container: container, select: select};
  };

  /**
   * Create the Resolve Metadata dialog.
   */
  self.createResolveConsistencyDialog = function() {
    const dialog = $('<div class="modal fade"></div>')
    const close = $('<a href="#" class="btn btn-default" data-dismiss="modal"></a>').text(_('Close'));
    close.on('click', self.closeModal);
    const select = $('<a href="#" class="btn btn-success"></a>').text(_('Select'));
    select.on('click', function() {
      const matchedFiles = self.targetFiles.filter(function(file, fileIndex) {
        return $('#metadata-target-' + fileIndex).is(':checked');
      });
      console.log('matchedFiles', matchedFiles, self.currentMetadata);
      if (matchedFiles.length === 0) {
        $(dialog).modal('hide');
        self.deleteMetadata(self.currentContext, self.currentMetadata.path);
        return;
      }
      osfBlock.block();
      self.resolveConsistency(matchedFiles[0].path)
        .finally(function() {
          osfBlock.unblock();
          $(dialog).modal('hide');
        });
    });
    const copyToClipboard = $('<button class="btn btn-default"></button>')
      .append($('<i></i>').addClass('fa fa-copy'))
      .append(_('Copy to clipboard'));
    const copyStatus = $('<div></div>');
    copyToClipboard.on('click', function(event) {
      self.copyToClipboard(event, copyStatus);
    });
    const container = $('<ul></ul>').css('padding', '0 20px');
    dialog
      .append($('<div class="modal-dialog modal-lg"></div>')
        .append($('<div class="modal-content"></div>')
          .append($('<div class="modal-header"></div>')
            .append($('<h3></h3>').text(_('Fix file metadata'))))
          .append($('<form></form>')
            .append($('<div class="modal-body"></div>')
              .append($('<div class="row"></div>')
                .append($('<div class="col-sm-12"></div>')
                  .append(container))))
            .append($('<div class="modal-footer"></div>')
              .css('display', 'flex')
              .css('align-items', 'center')
              .append(copyToClipboard.css('margin-left', 0).css('margin-right', 0))
              .append(copyStatus.css('margin-left', 0).css('margin-right', 'auto'))
              .append(close)
              .append(select)))));
    dialog.appendTo($('#treeGrid'));
    return {
      dialog: dialog,
      container: container,
      select: select,
      copyStatus: copyStatus,
    };
  };

  self.initPasteMetadataDialog = function() {
    const dialog = $('<div class="modal fade"></div>');
    const close = $('<a href="#" class="btn btn-default" data-dismiss="modal"></a>').text(_('Close'));
    dialog
      .append($('<div class="modal-dialog modal-lg"></div>')
        .append($('<div class="modal-content"></div>')
          .append($('<div class="modal-header"></div>')
            .append($('<h3></h3>').text(_('Paste Metadata'))))
          .append($('<form></form>')
            .append($('<div class="modal-body"></div>')
              .append($('<div class="row"></div>')
                .append($('<div class="col-sm-12"></div>')
                  .append(_('Press Ctrl-V (Command-V) to paste.'))
                  .append($('<br/>'))
                  .append(_('[Why is this needed?] In this browser, retrieving clipboard values with ' +
                    'button operations is prohibited. Therefore, you must explicitly indicate clipboard operations ' +
                    'by using the shortcut key or by pasting in the browser menu.')))))
            .append($('<div class="modal-footer"></div>')
              .append(close)))));
    dialog.appendTo($('#treeGrid'));
    if (!self.pasteMetadataEvent) {
      self.pasteMetadataEvent = function pasteEvent(event) {
        event.preventDefault();
        if (!dialog.hasClass('in')) {
          return;
        }
        const text = (event.clipboardData || window.clipboardData).getData('text');
        self.setMetadataFromJson(text);
        dialog.modal('hide');
      }
      document.addEventListener('paste', self.pasteMetadataEvent);
    }
    return dialog;
  };
}

if (contextVars.metadataAddonEnabled) {
  const btn = new MetadataButtons();
  contextVars.metadata = {
    loadMetadata: function(nodeId, nodeApiUrl, callback) {
      var metadataUrl = nodeApiUrl;
      if (!nodeApiUrl.match(/.+\/$/)) {
        metadataUrl += '/';
      }
      btn.loadMetadata(nodeId, metadataUrl + 'metadata/', callback);
    },
    getFileMetadata: function(nodeId, path) {
      if (!btn.contexts) {
        return undefined;
      }
      const context = btn.contexts[nodeId];
      if (!context) {
        return undefined;
      }
      const files = (context.projectMetadata || {}).files || [];
      const results = files.filter(function(metadata) {
        return metadata.path === path;
      });
      if (results.length === 0) {
        return null;
      }
      return results[0];
    },
    getProjectMetadata: function(nodeId) {
      if (!btn.contexts) {
        return undefined;
      }
      const context = btn.contexts[nodeId];
      if (!context) {
        return undefined;
      }
      return context.projectMetadata;
    },
    findSchemaById: function(schemaId) {
      return btn.findSchemaById(schemaId);
    },
    getRegistrations: function(callback) {
      if (!callback) {
        throw new Error('callback is required');
      }
      const r = new Registrations();
      r.load(function(error) {
        callback(error, r);
      });
    },
    getDraftRegistrations: function(callback) {
      if (!callback) {
        throw new Error('callback is required');
      }
      const r = new DraftRegistrations();
      r.load(function(error) {
        callback(error, r);
      });
    },
    isLoadingProjectMetadata: function(nodeId) {
      if (!btn.loadingMetadatas) {
        return true;
      }
      return btn.loadingMetadatas[nodeId];
    },
    extractProjectName: function(projectMetadata) {
      return btn.extractProjectName(projectMetadata);
    },
    createFileMetadataItemPage: function(fileMetadataItem) {
      const schema = btn.findSchemaById(fileMetadataItem.schema);
      if (!schema) {
        throw new Error('Schema not found: ' + fileMetadataItem.schema);
      }
      const questionPage = btn.createQuestionPage(
        schema.attributes.schema,
        fileMetadataItem,
        {
          readonly: true,
        }
      );
      return questionPage;
    },
    createProjectMetadataPage: function(registration) {
      const schemaId = registration.relationships.registration_schema.data.id;
      const schema = btn.findSchemaById(schemaId);
      if (!schema) {
        throw new Error('Schema not found: ' + schemaId);
      }
      const questionPage = btn.createProjectMetadataQuestionPage(
        schema.attributes.schema,
        registration.attributes.registration_metadata,
        {
          readonly: true,
        }
      );
      return questionPage;
    },
    addMoveCompleteHandler: function(handler) {
      btn.addMoveCompleteHandler(handler);
    },
  };
  if ($('#fileViewPanelLeft').length > 0) {
    // File View
    btn.initFileView();
  } else {
    // Project Dashboard / Files
    btn.initFileTree();
  }
}
