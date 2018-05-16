"use strict";

const path            = require('path');
const fs              = require('fs-extra');
const util            = require('util');
const readFilePromise = util.promisify(fs.readFile);
const _               = require('lodash');
const debug           = require('debug')("CriticalExtractor CSSTransformator");
const consola         = require('consola');
const merge           = require('deepmerge');
const css             = require('css');

/**
 *
 */
class CssTransformator {
    constructor(options) {
        options      = options || {};
        this.options = {
            silent: true,
            source: null
        };

        this.options = merge(this.options, options);

        const pseudoSelectorsToKeep = [
            ':before',
            ':after',
            ':visited',
            ':first-letter',
            ':first-line'
        ];

        // detect these selectors regardless of whether one or two semicolons are used
        const pseudoSelectorsToKeepRegex = pseudoSelectorsToKeep.map(s => {
            return ':?' + s;
        }).join('|');
        // separate in regular expression
        // we will replace all instances of these pseudo selectors; hence global flag
        this._PSUEDO_SELECTOR_REGEXP = new RegExp(pseudoSelectorsToKeepRegex, 'g');
    }

    getAst(cssContent) {
        let astObj = null;
        try {
            debug("getAst - Try parsing css to ast ...");
            astObj = css.parse(cssContent, {
                silent: this.options.silent,
                source: this.options.source
            });
            debug("getAst - Css successfully parsed to ast ...");
        } catch (err) {
            consola.error(err);
        }
        return astObj;
    }

    getCssFromAst(ast) {
        debug("getCssFromAst - Create css string out of AST");
        return css.stringify(ast, {
            indent: "  ",
            compress: false,
            sourcemap: true,
            inputSourcemaps: true
        })
    }

    matchesForceInclude(selector, forceInclude) {
        return forceInclude.some((includeSelector) => {
            if (includeSelector.type === 'RegExp') {
                const {source, flags} = includeSelector;
                const re              = new RegExp(source, flags);
                return re.test(selector);
            }
            return includeSelector.value === selector;
        })
    }

    /**
     * Filters targetAst to not contain any other values then in sourceAst
     * TODO: ignore keyframes rules
     *
     * @param sourceAst
     * @param targetAst
     * @returns {Promise<any>}
     */
    filter(sourceAst, targetAst) {
        return new Promise((resolve, reject) => {
            debug("filter - Filtering ast from source");
            if (targetAst.stylesheet) {
                let targetRules      = targetAst.stylesheet.rules;
                sourceAst.stylesheet = sourceAst.stylesheet || {rules: []};
                let sourceRules      = sourceAst.stylesheet.rules;

                targetAst.stylesheet.rules = _.filter(targetRules, (targetRule, index, collection) => {
                    // Target rule is media query?
                    if (targetRule.type === "media") {
                        // Get an array of all matching source media rules
                        let matchingSourceMediaArr = [];

                        for (let sourceRule of sourceRules) {
                            // Only respect matching media queries
                            if (sourceRule.type === "media") {
                                // Target rule may be slightly different because the CSSMediaRule does not count
                                // "all" as an important property because it is default. So it just removes it.
                                if (
                                    targetRule.media === sourceRule.media ||
                                    targetRule.media === sourceRule.media.replace("all and ", "")
                                ) {
                                    matchingSourceMediaArr = matchingSourceMediaArr.concat(sourceRule.rules);
                                }
                            }
                        }

                        targetRule.rules = _.filter(targetRule.rules, (targetMediaRule, index, collection) => {
                            for (let sourceMediaRule of matchingSourceMediaArr) {
                                const hasIdenticalSelectors = _.isEqual(sourceMediaRule.selectors, targetMediaRule.selectors);
                                if (hasIdenticalSelectors === true) {
                                    return true;
                                }
                            }
                            return false;
                        });

                        return targetRule.rules.length > 0;
                    } else {
                        for (let sourceRule of sourceRules) {
                            // Are the sourceRule selectors the same as the targetRule selectors -> keep
                            const hasIdenticalSelectors = _.isEqual(sourceRule.selectors, targetRule.selectors);
                            if (hasIdenticalSelectors === true) {
                                return true;
                            }
                        }
                    }

                    return false;
                });

                debug("filter - Successfully filtered AST!");
                resolve(targetAst);
            } else {
                debug("filter - ERROR no stylesheet property");
                reject(new Error("Target AST has no root node stylesheet. Stylesheet is properly wrong!"));
            }
        });
    }

    /**
     * Merge mergeAst into targetAst.
     * Keep targetAst properties if duplicate
     *
     * @param targetAst
     * @param mergeAst
     * @returns {Promise<Object>} AST
     */
    merge(targetAst, mergeAst) {
        return new Promise((resolve, reject) => {
            debug("merge - Try to merge into targetAst...");
            if (
                targetAst.type &&
                targetAst.type === "stylesheet" &&
                targetAst.stylesheet &&
                Array.isArray(targetAst.stylesheet.rules)
            ) {
                try {
                    // Iterate over merging AST
                    let mergeRules  = mergeAst.stylesheet.rules;
                    let targetRules = targetAst.stylesheet.rules;

                    for (let mergeRule of mergeRules) {
                        this.mergeRule(mergeRule, targetRules);
                    }
                    // Give back targetAst even though it was mutated
                    debug("merge - Successfully merged into targetAst!");
                    resolve(targetAst)
                } catch (err) {
                    // Catch errors if occur
                    debug("merge - general error occured.");
                    reject(err);
                }
            } else {
                debug("merge - ERROR because of missing properties!");
                reject(new Error("AST Merge failed due to missing properties"));
            }
        });
    }

    /**
     * Merges the rule object into the Array targetRules which should be an array of Rule objects
     *
     * NOTE: Muates the targetRules Array
     *
     * @param rule {Object}
     * @param targetRules {Array}
     */
    mergeRule(rule, targetRules) {
        // Handle media queries
        if (this.isMediaRule(rule)) {
            this.mergeMediaRule(rule, targetRules);
        } else {
            // Normal CSS-Rule
            if (targetRules.length > 0) {
                let isDuplicate = false;
                for (let targetRule of targetRules) {
                    // Does rule exists in targetRules?
                    // If not -> assimilate
                    if (this.isRuleDuplicate(targetRule, rule)) {
                        isDuplicate = true;
                        break;
                    }
                }
                if (!isDuplicate) {
                    // TODO: take care of positioning. The rule may need to overwrite something and could be inserted to early / late
                    targetRules.push(rule);
                }
            } else {
                // Empty targetRules -> create
                targetRules.push(rule);
            }
        }
    }

    /**
     * Merges a whole media rule with another. While rule is the main rule and targetArr is merges into that rule
     *
     * @param rule
     * @param targetArr
     */
    mergeMediaRule(rule, targetArr) {
        const selector = rule.media;
        const mediaRulesArr = rule.rules;
        let targetRulesArr = [];
        let hasNoMediaRule = true;

        for (let targetRule of targetArr) {
            if (this.isMediaRule(targetRule) && this.isMatchingMediaRuleSelector(selector, targetRule.media)) {
                targetRulesArr = targetRule.rules;
                hasNoMediaRule = false;
                break;
            }
        }

        if (hasNoMediaRule) {
            targetArr.push(rule);
        } else {
            for (let mediaRule of mediaRulesArr) {
                this.mergeRule(mediaRule, targetRulesArr)
            }
        }
    }

    /**
     * Returns true if rule1 is a duplicate of rule2.
     *
     * @param rule1 {Object}
     * @param rule2 {Object}
     * @returns {boolean}
     */
    isRuleDuplicate(rule1, rule2) {
        // Same selectors?? -> Check declaration if same
        if (_.isEqual(rule1.selectors, rule2.selectors)) {
            let r1Declarations  = rule1.declarations;
            let r2Declarations = rule2.declarations;

            // Check diff by length
            if (r1Declarations.length !== r2Declarations.length) {
                return false;
            } else {
                // Same length! Check single declarations
                let r1DeclCount     = r1Declarations.length;
                let r2DeclMatches = 0;

                // Iterate over both declarations and check diff in detail
                // we only count the amount of hits of the same declaration and comparing the result count
                // with the previous count of declarations to be merged. If they are equal
                // we got the same rule
                for (let r1Decl of r1Declarations) {
                    for (let r2Decl of r2Declarations) {
                        // Is declaration the same?
                        if (r2Decl.property === r1Decl.property && r2Decl.value === r1Decl.value) {
                            r2DeclMatches++;
                            break;
                        }
                    }
                }

                // Different declarations in both arrays? > create new rule
                if (r1DeclCount === r2DeclMatches) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Returns true if rule is of type "media"
     *
     * @param rule
     * @returns {boolean}
     */
    isMediaRule(rule) {
        return rule.type === "media";
    }

    /**
     * Returns true if selector_1 is matching selector_2 as a media rule selector.
     * Also checks valid differences between media selectors that mean the same.
     *
     * @param selector_1
     * @param selector_2
     * @returns {boolean}
     */
    isMatchingMediaRuleSelector(selector_1, selector_2) {
        return selector_1 === selector_2 ||
            selector_1 === selector_2.replace("all and ", "") ||
            selector_2 === selector_1.replace("all and ", "") ||
            selector_1.replace("all and ", "") === selector_2.replace("all and ", "")
    }
}

module.exports = CssTransformator;